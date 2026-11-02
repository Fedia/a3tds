const main = document.querySelector('main');
const content = document.querySelector('#content');
setInterval(() => { document.querySelector('#clock').textContent = Date.now(); }, 50);
setTimeout(() => {
  content.textContent = 'Получены данные: температура воздуха +7, источник — тестовая страница.';
}, 350);
setTimeout(() => {
  document.querySelector('#moving').style.top = '24px';
}, 650);
setTimeout(() => {
  main.setAttribute('aria-busy', 'false');
  document.querySelector('#busy').remove();
}, 900);
document.querySelector('#change').onclick = () => {
  main.setAttribute('aria-busy', 'true');
  setTimeout(() => {
    content.textContent = 'Обновлённые данные: температура воздуха +9.';
    main.setAttribute('aria-busy', 'false');
  }, 500);
};
