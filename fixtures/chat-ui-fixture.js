document.querySelector('#task').textContent = 'Режим браузерного агента.\nЗадача: Собери темы с четырёх страниц\nОтвет — один JSON\nСостояние: {"steps":0}';
document.querySelector('#answer').textContent = JSON.stringify({
  id: 'step',
  tool: 'python.run',
  args: {
    code: 'result=1',
    data: {}
  },
  description: 'Повторно объединить темы с четырёх страниц'
});
