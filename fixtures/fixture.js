document.querySelector('#mutate').onclick = () => {
  const p = document.createElement('p');
  p.textContent = 'Новый текст после изменения DOM';
  document.querySelector('main').append(p);
};
