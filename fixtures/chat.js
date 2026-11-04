document.querySelector('#send').onclick = () => {
  document.querySelector('#composer').value = '';
  const stop = document.createElement('button');
  stop.id = 'stop';
  stop.setAttribute('aria-label', 'Stop generating');
  document.body.append(stop);
  setTimeout(() => {
    const e = document.createElement('div');
    e.className = 'answer';
    e.dataset.messageAuthorRole = 'assistant';
    e.textContent = 'Тестовый ответ завершён.';
    document.querySelector('#answers').append(e);
    stop.remove();
    const done = document.createElement('button');
    done.setAttribute('aria-label', 'Copy');
    done.className = 'complete';
    e.append(done);
  }, 100);
};
