import { Link } from 'react-router-dom'
import { PHOTOS } from '../photos.ts'
import { SHELVES } from '../shelves.ts'

/** 頁尾（AIC-019）：店名「Demo」「Shop」用兩塊色塊蓋起來收尾；照片出處一定要列在這裡 */
export function SiteFooter() {
  return (
    <footer className="foot">
      <div className="foot-mark" aria-hidden="true">
        <span>Demo</span>
        <span>Shop</span>
      </div>
      <div className="foot-cols">
        <div>
          <h3>逛</h3>
          {SHELVES.map((s) => <Link key={s.id} to={{ pathname: '/', hash: `#${s.id}` }}>{s.title}</Link>)}
        </div>
        <div>
          <h3>我的</h3>
          <Link to="/cart">購物車</Link>
          <Link to="/me/orders">訂單</Link>
          <Link to="/me/warehouse">寄倉</Link>
        </div>
        <div>
          <h3>找人</h3>
          <p>右下角的「客服」：隨便逛逛找 AI 助理，叫你們經理出來找真人。</p>
        </div>
        <div className="credits">
          <h3>照片出處</h3>
          {Object.values(PHOTOS).map((p) => (
            <p key={p.src}>
              <a href={p.page} target="_blank" rel="noreferrer">{p.title}</a>，{p.creator}，{p.license}，Wikimedia Commons
            </p>
          ))}
          <p>商品圖是程式畫的示意圖。</p>
        </div>
      </div>
      <div className="foot-last">
        <span>Demo Shop 是 demo 用的虛構商店，商品和品牌都是編的。</span>
        <a className="button" href="#top">回到最上面</a>
      </div>
    </footer>
  )
}
