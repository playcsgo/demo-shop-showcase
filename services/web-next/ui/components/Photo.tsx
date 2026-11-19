'use client'

import type { Photo as PhotoData } from '../photos.ts'

/** 氣氛照（photos.ts）：寬高先給，載入時版面不跳；首屏以外都延後載入 */
export function Photo({ photo, eager }: { photo: PhotoData; eager?: boolean }) {
  return <img src={photo.src} alt={photo.alt} width={photo.w} height={photo.h} loading={eager ? 'eager' : 'lazy'} />
}
