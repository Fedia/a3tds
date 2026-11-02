import {
  assert,
  bounded,
  hash,
  sleep
} from './util.js';

const terminal = status => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export const pythonJobKey = (taskId, jobId) => 'python-job:' + taskId + ':' + jobId;
/** Task-scoped background jobs. Full outputs are staged before export; code is never replayed. */
export class PythonJobs {
  constructor({
    runtime,
    store,
    files,
    state
  }) {
    Object.assign(this, {
      runtime,
      store,
      files,
      state
    });
    this.jobs = new Map();
  }
  rebind(state) {
    this.state = state;
    for (const [id, job] of this.jobs) {
      state.pythonJobs ??= {};
      state.pythonJobs[id] = this.view(job.record);
    }
  }
  async publish(job) {
    await this.store.putPythonJob(pythonJobKey(job.record.taskId, job.record.jobId), job.record);
    this.state.pythonJobs ??= {};
    this.state.pythonJobs[job.record.jobId] = this.view(job.record);
    const marker = JSON.stringify([job.record.status, !!job.record.outcome, job.record.result?.savedPath, this.state.files.length]);
    if (marker !== job.patchMarker) {
      await this.store.patchPythonJob(this.state.id, job.record.jobId, this.state.pythonJobs[job.record.jobId], this.state.files);
      job.patchMarker = marker;
    }
    if (this.store.name === 'psy-agent') await chrome.storage.local.set({
      ['python-ui:' + this.state.id]: this.state.pythonJobs
    });
  }
  view(record) {
    const now = Date.now();
    return {
      jobId: record.jobId,
      status: record.status,
      phase: record.phase,
      started: record.started,
      elapsedSeconds: Math.floor(((record.finished || now) - record.started) / 1000),
      codeSeconds: record.codeStarted ? Math.floor(((record.finished || now) - record.codeStarted) / 1000) : 0,
      secondsSinceEvent: Math.floor((now - record.updated) / 1000),
      progress: record.progress ?? null,
      ...(record.result || {}),
      stdout: (record.stdout || '').slice(-4000),
      stderr: (record.stderr || '').slice(-2000),
      stdoutTruncated: !!record.result?.stdoutTruncated || (record.stdout || '').length > 4000,
      stderrTruncated: !!record.result?.stderrTruncated || (record.stderr || '').length > 2000,
      ...(record.error ? {
        error: record.error
      } : {}),
      ...(record.outcome ? {
        exportPending: true,
        exportError: record.exportError || null
      } : {})
    };
  }
  async get(id) {
    assert(typeof id === 'string', 'Нужен jobId');
    let job = this.jobs.get(id);
    if (!job) {
      const record = await this.store.get(pythonJobKey(this.state.id, id));
      assert(record?.taskId === this.state.id, 'Python-задача не принадлежит текущей задаче агента');
      job = {
        record,
        updates: Promise.resolve()
      };
      this.jobs.set(id, job);
      if (record.result?.savedPath)
        for (const path of [record.result.savedPath, ...(record.result.files || []).map(file => file.path)])
          if (!this.state.files.includes(path)) this.state.files.push(path);
      if (!terminal(record.status)) {
        record.status = 'interrupted';
        record.phase = 'interrupted';
        record.finished = Date.now();
        record.error = {
          code: 'WORKER_LOST',
          message: 'Вкладка или браузер были закрыты. Вычисление не перезапускалось.'
        };
        await this.publish(job);
      }
    }
    return job;
  }
  async restore() {
    for (const id of Object.keys(this.state.pythonJobs || {})) await this.get(id);
  }
  async hasActive() {
    await this.restore();
    return [...this.jobs.values()].some(job => !terminal(job.record.status));
  }
  async start(command, inputs) {
    const id = command.id;
    if (this.jobs.has(id) || await this.store.get(pythonJobKey(this.state.id, id))) return this.status(id, 0);
    assert(!await this.hasActive(), 'Python уже выполняется. Используй python.status или python.cancel для текущего jobId.');
    const record = {
      taskId: this.state.id,
      jobId: id,
      status: 'running',
      phase: 'queued',
      started: Date.now(),
      updated: Date.now()
    };
    const job = {
      record,
      updates: Promise.resolve()
    };
    this.jobs.set(id, job);
    await this.publish(job); // Durable intent before creating any Worker.
    const queueUpdate = () => {
      if (!job.publishTimer) job.publishTimer = setTimeout(() => {
        job.publishTimer = null;
        job.updates = job.updates.catch(() => {}).then(() => this.publish(job));
      }, 500);
    };
    const update = (phase, detail) => {
      if (terminal(record.status)) return;
      record.phase = phase;
      record.updated = Date.now();
      if (phase === 'running') record.codeStarted ??= Date.now();
      if (detail !== undefined) {
        try {
          record.progress = JSON.parse(detail);
        } catch {
          record.progress = String(detail).slice(0, 2000);
        }
      }
      queueUpdate();
    };
    const execute = async () => {
      job.heartbeat = setInterval(() => {
        job.updates = job.updates.catch(() => {}).then(() => this.publish(job));
      }, 5000);
      this.runtime.onProgress = update;
      this.runtime.onOutput = output => {
        record[output.stream] = output.text;
        record.updated = Date.now();
        queueUpdate();
      };
      try {
        const run = () => {
          if (job.cancelReason) throw new Error(job.cancelReason);
          return this.runtime.run(command.args.code, command.args.data, null, inputs)
        };
        const outcome = navigator.locks?.request ? await navigator.locks.request('psy-agent-python', {
          ifAvailable: true
        }, lock => {
          if (!lock) {
            const error = new Error('Python выполняется в другом чате.');
            error.code = 'PYTHON_BUSY';
            throw error;
          }
          return run();
        }) : await run();
        record.status = 'completed';
        record.phase = 'completed';
        record.finished = Date.now();
        record.stdout = outcome.stdout;
        record.stderr = outcome.stderr;
        record.outcome = outcome;
        job.staging = (async () => {
          await job.updates.catch(() => {});
          await this.publish(job);
        })();
        await job.staging; // Output bytes survive a failed export or a reload.
        await this.export(job).catch(() => {});
      } catch (error) {
        record.status = job.cancelReason || /прерван|остановлен пользователем/i.test(error.message) ? 'cancelled' : 'failed';
        record.phase = error.pythonPhase || record.phase;
        record.finished = Date.now();
        record.error = {
          code: error.code || 'PYTHON_FAILED',
          message: job.cancelReason || error.message
        };
        await job.updates.catch(() => {});
        await this.publish(job);
      }
    };
    job.completion = execute().finally(() => {
      clearInterval(job.heartbeat);
      clearTimeout(job.publishTimer);
    }).catch(async error => {
      record.status = 'failed';
      record.error = {
        code: 'PYTHON_JOB_FAILED',
        message: error.message
      };
      record.finished = Date.now();
      await this.publish(job).catch(() => {});
    });
    return this.view(record);
  }
  async writeOnce(path, value, operationId) {
    const previous = await this.store.get('write:' + operationId);
    if (previous) {
      try {
        const file = await this.files.file(previous.path);
        if (await hash(new Uint8Array(await file.arrayBuffer())) === previous.hash) return {
          path: previous.path
        };
      } catch {}
    }
    return this.files.write(path, value, {
      operationId
    });
  }
  export (job) {
    if (!job.exporting) {
      const execute = async () => {
        await job.staging;
        job.record = await this.store.get(pythonJobKey(this.state.id, job.record.jobId)) || job.record;
        if (job.record.result?.savedPath)
          for (const path of [job.record.result.savedPath, ...(job.record.result.files || []).map(file => file.path)])
            if (!this.state.files.includes(path)) this.state.files.push(path);
        return this.exportOutput(job);
      };
      job.exporting = (navigator.locks?.request ? navigator.locks.request('psy-agent-python-export:' + this.state.id + ':' + job.record.jobId, execute) : execute()).finally(() => {
        job.exporting = null;
      });
    }
    return job.exporting;
  }
  async exportOutput(job) {
    const r = job.record,
      outcome = r.outcome;
    if (!outcome) return;
    try {
      const base = 'tasks/' + r.taskId,
        op = 'python-output:' + r.taskId + ':' + r.jobId;
      const full = await this.writeOnce(base + '/python-result-' + r.jobId + '.json', JSON.stringify({
        ...outcome,
        files: outcome.files.map(f => ({
          path: f.path,
          bytes: f.bytes.length
        }))
      }, null, 2), op + ':summary');
      const created = [];
      for (const file of outcome.files) created.push(await this.writeOnce(base + '/python/step-' + r.jobId + '/' + file.path, new Uint8Array(file.bytes), op + ':' + file.path));
      r.result = {
        savedPath: full.path,
        files: created,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        stdoutTruncated: outcome.stdoutTruncated,
        stderrTruncated: outcome.stderrTruncated,
        result: bounded(outcome.result, 6000)
      };
      for (const path of [full.path, ...created.map(f => f.path)])
        if (!this.state.files.includes(path)) this.state.files.push(path);
      delete r.outcome;
      delete r.exportError;
      await this.publish(job);
    } catch (error) {
      r.exportError = error.message;
      await this.publish(job);
      throw error;
    }
  }
  async status(id, waitMs = 1000) {
    const job = await this.get(id);
    if (!terminal(job.record.status) && waitMs > 0) await Promise.race([job.completion, sleep(Math.min(waitMs, 15000))]);
    await job.updates.catch(() => {});
    if (job.record.outcome) await this.export(job).catch(() => {});
    await this.publish(job);
    return this.view(job.record);
  }
  async cancel(id, reason = 'Вычисление остановлено') {
    const job = await this.get(id);
    if (!terminal(job.record.status)) {
      job.cancelReason = reason;
      this.runtime.cancel();
      await job.completion;
    }
    return this.view(job.record);
  }
  async cancelActive(reason = 'Вычисление остановлено пользователем') {
    await this.restore();
    for (const [id, job] of this.jobs)
      if (!terminal(job.record.status)) await this.cancel(id, reason);
  }
  async flushPending() {
    for (const key of await this.store.get('python-export-queue') || []) {
      const record = await this.store.get(key);
      if (!record?.outcome) continue;
      if (record.taskId === this.state.id) await this.export(await this.get(record.jobId));
      else {
        const archive = await this.store.get('archive-' + record.taskId) || {
          id: record.taskId,
          files: [],
          pythonJobs: {}
        };
        const exporter = new PythonJobs({
          runtime: this.runtime,
          store: this.store,
          files: this.files,
          state: archive
        });
        const job = await exporter.get(record.jobId);
        await exporter.export(job);
      }
    }
  }
  async flush() {
    await this.restore();
    for (const job of this.jobs.values())
      if (job.record.outcome) await this.export(job);
  }
}
