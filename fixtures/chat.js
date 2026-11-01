document.querySelector('#send').onclick = () => {
  document.querySelector('#composer').value = '';
  const stop = document.createElement('button');
  stop.id = 'stop';
  document.body.append(stop);
  setTimeout(() => {
    const e = document.createElement('div');
    e.className = 'answer';
    e.textContent =
      '{"id":"fixture-final","tool":"task.finish","args":{"summary":"Fixture complete"},"description":"Завершение"}';
    document.querySelector('#answers').append(e);
    stop.remove();
    const done = document.createElement('div');
    done.className = 'complete';
    e.append(done);
  }, 100);
};
