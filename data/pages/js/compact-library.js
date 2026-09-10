(function () {
  const compact = matchMedia('(min-width:640px) and (max-height:900px) and (orientation:landscape)')
  window.RvBCompactLibrary = {
    active: () => compact.matches,
    detail(card) {
      if (card.querySelector('.library-tabs')) return
      const panels = [...card.querySelectorAll('.skills-panel,.related-cards-panel,.keywords-panel')]
      const tabs = document.createElement('nav'); tabs.className = 'library-tabs'; tabs.setAttribute('aria-label', '棋子详情分类')
      const close = document.createElement('button'); close.className = 'library-close'; close.textContent = '返回图鉴'; close.onclick = e => { e.stopPropagation(); card.classList.remove('expanded') }
      const pages = document.createElement('div'); pages.className = 'library-pages'
      const previous = document.createElement('button'), next = document.createElement('button'), count = document.createElement('span')
      previous.textContent = '上一组'; next.textContent = '下一组'; pages.append(previous,count,next)
      let selected = 0, page = 0
      const pageSize = innerWidth >= 880 ? 3 : 2
      function update() {
        panels.forEach((panel,i) => { panel.dataset.libraryHidden = String(i !== selected) })
        ;[...tabs.children].forEach((button,i) => button.setAttribute('aria-selected',String(i === selected)))
        const skills = [...panels[0].querySelectorAll('.skill-row')], total = Math.max(1,Math.ceil(skills.length / pageSize))
        skills.forEach((skill,i) => { skill.dataset.libraryHidden = String(Math.floor(i / pageSize) !== page) })
        count.textContent = (page+1) + ' / ' + total; previous.disabled = page === 0; next.disabled = page === total-1
        pages.dataset.libraryHidden = String(selected !== 0 || total === 1)
      }
      panels.forEach((panel,i) => {
        const button = document.createElement('button'); button.textContent = panel.classList.contains('skills-panel') ? '技能' : panel.classList.contains('related-cards-panel') ? '相关手牌' : '关键词'
        button.onclick = e => {e.stopPropagation();selected=i;update()}; tabs.appendChild(button)
      })
      previous.onclick = e => { e.stopPropagation();page--;update() }; next.onclick = e => {e.stopPropagation();page++;update()}
      card.append(tabs,close,pages); update()
    },
    lessons() {
      const list = document.getElementById('lessons'), cards = [...list.querySelectorAll('.lesson-card')]
      const nav = document.createElement('nav'); nav.className = 'lesson-pages'; nav.setAttribute('aria-label','选择练习章节')
      let selected = 0
      const update = () => { cards.forEach((card,i) => card.hidden = compact.matches && i !== selected); [...nav.children].forEach((button,i) => button.setAttribute('aria-current',String(i === selected))) }
      cards.forEach((card,i) => { const button = document.createElement('button'); button.textContent='第 '+(i+1)+' 局';button.onclick=()=>{selected=i;update()};nav.appendChild(button) })
      list.appendChild(nav);compact.addEventListener('change',update);update()
    }
  }
})()
