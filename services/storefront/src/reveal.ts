// 進場動畫（AIC-019）：有 data-reveal 的元素捲進畫面時加上 .in。
// 隱藏狀態只在 html.js 底下才生效，所以這支沒跑起來時內容照常顯示。
// 商品是非同步載入的，用 MutationObserver 接住之後才出現的元素。
export function startReveal() {
  document.documentElement.classList.add('js')
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('in')
      seen.unobserve(e.target)
    }
  }, { rootMargin: '0px 0px 15% 0px' }) // 捲到前一點就開始：快速捲動時內容不會還是透明的

  const scan = () => document.querySelectorAll('[data-reveal]:not(.in)').forEach((el) => seen.observe(el))
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
  scan()
}
