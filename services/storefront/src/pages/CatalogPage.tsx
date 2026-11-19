import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, money, track } from '../api.ts'
import { useMe } from '../App.tsx'
import { Photo } from '../components/Photo.tsx'
import { PHOTOS } from '../photos.ts'
import { delay, field, SHELVES } from '../shelves.ts'

type Variant = { id: number; sku: string; name: string; flavor: string | null; size_label: string | null; price: number; shipping_class: string; in_stock: boolean }
type Product = {
  id: number; slug: string | null; name: string; category: string | null; species: string[]; warnings: string[]; description_md: string | null
  image_url: string | null; brand: { code: string; name: string }; delivery_modes: string[]; variants: Variant[]
}

const MODE_LABEL: Record<string, string> = { direct: '直送', warehouse: '寄倉', subscription: '訂閱', booking: '預約' }
const SPECIES_LABEL: Record<string, string> = { cat: '貓', dog: '狗' }
// 一個商品有好幾個 SKU 時，選單上顯示口味和規格
const variantLabel = (v: Variant) => [v.flavor, v.size_label].filter(Boolean).join(' ') || v.sku

const fmtSlot = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const BULKY = ['bulky', 'litter'] // 狗屋、貓砂走大型物流（AIC-017）

const species = (p: Product) => p.species.map((x) => SPECIES_LABEL[x] ?? x).join('、')
const SEED_W = 800, SEED_H = 600 // 種子商品圖的尺寸（AIC-011）
const priceFrom = (p: Product) => money(Math.min(...p.variants.map((v) => v.price))) + (p.variants.length > 1 ? ' 起' : '')

export function CatalogPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [toast, setToast] = useState('')
  const { hash } = useLocation()

  useEffect(() => { api<{ data: Product[] }>('/catalog').then((r) => setProducts(r.data)) }, [])
  // 從別頁點頁尾的貨架連結進來：商品載入後才捲得到那一層。直接跳過去，不用平滑捲動（剛換頁，沒有「從哪裡來」可看）
  useEffect(() => { if (hash && products.length) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'instant' }) }, [hash, products.length])

  // 不認得的品牌另外成一層；用代號去重（每個商品的 brand 都是不同的物件）
  const known = new Set<string>(SHELVES.map((s) => s.code))
  const others = [...new Map(products.filter((p) => !known.has(p.brand.code)).map((p) => [p.brand.code, p.brand])).values()]
  const shelves = [
    ...SHELVES.map((s) => ({ id: s.id, title: s.title, items: products.filter((p) => p.brand.code === s.code) })),
    ...others.map((b) => ({ id: `brand-${b.code}`, title: b.name, items: products.filter((p) => p.brand.code === b.code) })),
  ].filter((s) => s.items.length > 0)

  return (
    <>
      <Hero products={products} />
      {toast && <div className="toast" role="status" onAnimationEnd={() => setToast('')}>{toast}</div>}

      <section className="pair" aria-labelledby="pair-h">
        <PetPanel pet="dog" mark="狗" photo={PHOTOS.shiba} products={products} heading="狗一邊，貓一邊" />
        <PetPanel pet="cat" mark="貓" photo={PHOTOS.tabby} products={products} />
      </section>

      <div className="shelves">
        {shelves.map((s) => (
          <section key={s.id} id={s.id} className="shelf" aria-labelledby={`${s.id}-h`}>
            <div className="shelf-head" data-reveal>
              <h2 id={`${s.id}-h`}>{s.title}</h2>
              <p>{s.items[0].brand.name}・{s.items.length} 樣</p>
            </div>
            <div className="shelf-items">
              {s.items.map((p, i) => <ProductCard key={p.id} product={p} onAdded={setToast} revealStep={i % 2} />)}
            </div>
          </section>
        ))}
      </div>

      <section className="grow" aria-labelledby="grow-h">
        <div className="grow-head">
          <h2 id="grow-h" data-reveal>罐頭可以先寄放</h2>
          <p className="grow-say" data-reveal style={delay(1)}>
            整箱買比較划算，但家裡放不下。加入購物車時交付選「寄倉」，罐頭留在我們這裡，要吃再領。
          </p>
        </div>
        <figure className="stage-1" data-reveal style={delay(2)}>
          <div className="stage-pic"><Photo photo={PHOTOS.ballKitten} /></div>
          <figcaption><strong>先買一箱</strong><span>一箱 12 或 24 罐，每罐比單買便宜。</span></figcaption>
        </figure>
        <figure className="stage-2" data-reveal style={delay(3)}>
          <div className="stage-pic"><Photo photo={PHOTOS.chairCat} /></div>
          <figcaption><strong>放在我們倉庫</strong><span>會員中心看得到還剩幾罐。</span></figcaption>
        </figure>
        <figure className="stage-3" data-reveal style={delay(4)}>
          <div className="stage-pic"><Photo photo={PHOTOS.twoShiba} /></div>
          <figcaption><strong>想吃再領</strong><span>在<Link to="/me/warehouse">寄倉</Link>按「提領」，一次寄一包出去。</span></figcaption>
        </figure>
      </section>
    </>
  )
}

/** 狗、貓各一塊：照片、這邊有幾樣、跳到吃的／用的兩層 */
function PetPanel({ pet, mark, photo, products, heading }: { pet: 'dog' | 'cat'; mark: string; photo: typeof PHOTOS.shiba; products: Product[]; heading?: string }) {
  const shelves = SHELVES.filter((s) => s.pet === pet)
  const count = products.filter((p) => shelves.some((s) => s.code === p.brand.code)).length
  return (
    <div className={`panel panel-${pet}`}>
      {heading ? <h2 id="pair-h" data-reveal>{heading}</h2> : <div className="panel-spacer" aria-hidden="true" />}
      <div className="photo" data-reveal style={delay(1)}><Photo photo={photo} /></div>
      <div className="panel-row" data-reveal style={delay(2)}>
        <p><strong>{mark}</strong>{shelves.map((s) => s.title).join('、')}，{count} 樣</p>
        <span className="acts">
          {shelves.map((s, i) => <a key={s.id} className={i ? 'button paper' : 'button'} href={`#${s.id}`}>{s.title.slice(1)}</a>)}
        </span>
      </div>
    </div>
  )
}

/**
 * 首屏：一個商品當標本站在色塊上，左邊一串名字可以挑（taste-skill 的「單一標本＋名字清單」）。
 * 沒人碰時每 6 秒換下一個，慢慢交叉淡入；使用者挑過、分頁在背景、或要求減少動態時就停。
 */
function Hero({ products }: { products: Product[] }) {
  const [sel, setSel] = useState(0)
  const [prev, setPrev] = useState<number | null>(null)
  const [touched, setTouched] = useState(false) // 挑過一次就不再自己換
  const [paused, setPaused] = useState(false) // 滑鼠或焦點在首屏時暫停（WCAG 2.2.2）
  const n = products.length

  function pick(i: number) {
    if (i === sel) return
    setPrev(sel)
    setSel(i)
  }

  useEffect(() => {
    if (touched || paused || n < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setTimeout(() => {
      if (document.hidden) return
      setPrev(sel)
      setSel((sel + 1) % n)
    }, 6000)
    return () => clearTimeout(t)
  }, [sel, n, touched, paused])
  useEffect(() => {
    if (prev === null) return
    const t = setTimeout(() => setPrev(null), 1600)
    return () => clearTimeout(t)
  }, [prev])

  const p = products[sel]
  const old = prev !== null ? products[prev] : null
  // 名字清單：以選到的為中心，前後各三個（頭尾接起來；商品少時就少列幾個，不重複）
  const radius = Math.max(0, Math.min(3, Math.floor((n - 1) / 2)))
  const names = n === 0 ? [] : Array.from({ length: 2 * radius + 1 }, (_, k) => k - radius).map((d) => ({ d, i: (((sel + d) % n) + n) % n }))

  return (
    <section className="hero" aria-labelledby="hero-h"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <h1 id="hero-h">Demo Shop</h1>
      <p className="hero-say">狗和貓的吃的、用的，一共 {n || '十幾'} 樣，不適合哪些毛孩就寫在旁邊。整箱可以寄放，貓砂和狗屋走大型物流。</p>
      <div className="stage">
        <ul className="names" aria-label="挑一個商品看">
          {names.map(({ d, i }) => (
            <li key={products[i].id} data-d={Math.abs(d)}>
              <button aria-pressed={d === 0} onClick={() => { setTouched(true); pick(i) }}>{products[i].name}</button>
            </li>
          ))}
        </ul>
        {p && (
          <div className="specimen">
            <div className="tile" style={field(p.brand.code)}>
              {old && old.image_url && <img key={`old-${old.id}`} className="leaving" src={old.image_url} alt="" aria-hidden="true" />}
              {p.image_url && <img key={p.id} className={old ? 'coming' : ''} src={p.image_url} alt={p.name} width={SEED_W} height={SEED_H} />}
            </div>
            {/* 自己換的時候不唸，免得每 6 秒打斷螢幕報讀 */}
            <p className="name" aria-live={touched ? 'polite' : 'off'}>{p.name}</p>
            <p className="fact">{p.brand.name}・適用：{species(p)}・{priceFrom(p)}</p>
            <a className="button primary" href={`#p-${p.id}`}>看這個商品</a>
          </div>
        )}
      </div>
      <nav className="hero-links" aria-label="貨架">
        {SHELVES.map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
      </nav>
    </section>
  )
}

/** 商品介紹：打開才放內容（收起來時不佔版面，也不會被當成標題上的小標） */
function Description({ md }: { md: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="description" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>商品介紹</summary>
      {open && <div>{md.split('\n').filter((l) => l.trim()).map((l, i) =>
        l.startsWith('## ') ? <h4 key={i}>{l.slice(3)}</h4> : <p key={i}>{l.replace(/^- /, '・')}</p>)}</div>}
    </details>
  )
}

// 商品圖片：網址由 core 給（本機走 core 的 /media，正式環境是 CDN）；沒有圖或載入失敗就顯示品牌色的預設圖
function ProductImage({ product }: { product: Product }) {
  const [failed, setFailed] = useState(false)
  if (!product.image_url || failed) {
    return <div className="item-pic placeholder" style={field(product.brand.code)} aria-hidden="true">{product.name.slice(0, 1)}</div>
  }
  return (
    <div className="item-pic" style={field(product.brand.code)}>
      <img src={product.image_url} alt={product.name} width={SEED_W} height={SEED_H} loading="lazy" onError={() => setFailed(true)} />
    </div>
  )
}

function ProductCard({ product, onAdded, revealStep }: { product: Product; onAdded: (msg: string) => void; revealStep: number }) {
  const { me } = useMe()
  const navigate = useNavigate()
  const [variantId, setVariantId] = useState(product.variants[0].id)
  const v = product.variants.find((x) => x.id === variantId) ?? product.variants[0]
  const [mode, setMode] = useState(product.delivery_modes[0])
  const [qty, setQty] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 預約（§6.4.1）：選日期時間；加入購物車時醫院就會保留這個時段（額滿當場告知）
  const [at, setAt] = useState(() => new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10) + 'T14:00')

  async function add() {
    if (!me) return navigate('/login')
    setError(''); setBusy(true)
    try {
      await api('/cart/items', {
        method: 'PUT',
        body: JSON.stringify({ variant_id: v.id, fulfillment_type: mode, qty, ...(mode === 'booking' ? { appointment_at: new Date(at).toISOString() } : {}) }),
      })
      track('add_to_cart', { sku: v.sku, qty, mode })
      onAdded(mode === 'booking' ? `已保留時段：${fmtSlot(at)}（請在時間內結帳）` : `已加入購物車：${v.name}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加入失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="item" id={`p-${product.id}`} data-reveal style={delay(revealStep)}>
      <ProductImage product={product} />
      <div className="item-body">
        <div className="item-head">
          <h3>{product.name}</h3>
          <p className="price">{money(v.price)}</p>
        </div>
        <p className="item-meta">
          <span className="brand" style={field(product.brand.code)}>{product.brand.code}</span> {product.brand.name}
          {product.species.length > 0 && <>・適用：{species(product)}</>}
        </p>
        {product.variants.length > 1 && (
          <select aria-label="口味和規格" value={v.id} onChange={(e) => setVariantId(Number(e.target.value))}>
            {product.variants.map((x) => <option key={x.id} value={x.id}>{variantLabel(x)}{x.in_stock ? '' : '（售完）'}</option>)}
          </select>
        )}
        {product.warnings.length > 0 && (
          <ul className="note" aria-label="不適用的情況">
            {product.warnings.map((w) => <li key={w}>不適用：{w}</li>)}
          </ul>
        )}
        {BULKY.includes(v.shipping_class) && <p className="note">大型物流配送，比一般宅配慢</p>}
        {product.description_md && <Description md={product.description_md} />}
        <div className="controls">
          <select aria-label="交付方式" value={mode} onChange={(e) => setMode(e.target.value)}>
            {product.delivery_modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
          {mode === 'booking'
            ? <input aria-label="預約時間" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            : <input aria-label="數量" type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Number(e.target.value))} />}
          <button onClick={add} disabled={!v.in_stock || busy}>{!v.in_stock ? '售完' : mode === 'booking' ? '保留時段並加入購物車' : '加入購物車'}</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </article>
  )
}
