// 前台用到的照片（AIC-019）：都是 Wikimedia Commons 上的公有領域或 CC0 照片，只當氣氛照，不代表任何商品。
// 檔案在 public/photos/，出處同時記在 public/CREDITS.md 和 photos/credits.json，頁尾也會列出來。
export type Photo = { src: string; alt: string; title: string; creator: string; license: string; page: string; w: number; h: number }

export const PHOTOS = {
  shiba: { src: '/photos/shiba-inu-taiki.jpg', alt: '一隻柴犬張嘴笑著看鏡頭', title: 'Shiba inu taiki', creator: 'Roberto Vasarri', license: '公有領域', page: 'https://commons.wikimedia.org/wiki/File:Shiba_inu_taiki.jpg', w: 1188, h: 1400 },
  tabby: { src: '/photos/tabby-cat-with-blue-eyes-3336579.jpg', alt: '一隻藍眼睛的虎斑白貓', title: 'Tabby cat with blue eyes', creator: 'AdinaVoicu', license: 'CC0', page: 'https://commons.wikimedia.org/wiki/File:Tabby_cat_with_blue_eyes-3336579.jpg', w: 1165, h: 1400 },
  kitten: { src: '/photos/kitten-sleeping.jpg', alt: '一隻小貓仰躺著睡覺，露出腳掌', title: 'Kitten sleeping', creator: 'Pixabay', license: 'CC0', page: 'https://commons.wikimedia.org/wiki/File:Kitten_sleeping.jpg', w: 1400, h: 933 },
  twoShiba: { src: '/photos/two-shiba-inu-dogs.jpg', alt: '兩隻柴犬靠在一起趴在草地上', title: 'Two Shiba Inu dogs', creator: 'Novoklimov', license: 'CC0', page: 'https://commons.wikimedia.org/wiki/File:Two_Shiba_Inu_dogs.jpg', w: 1400, h: 1011 },
  ballKitten: { src: '/photos/ginger-kitten-with-an-orange-rubber-rugby.jpg', alt: '一隻橘色小貓躺在地上，旁邊有一顆橘色的球', title: 'Ginger kitten with an orange rubber rugby', creator: 'Aiaikz', license: 'CC0', page: 'https://commons.wikimedia.org/wiki/File:Ginger_kitten_with_an_orange_rubber_rugby.jpg', w: 1320, h: 1400 },
  chairCat: { src: '/photos/domestic-cat-2019-g1.jpg', alt: '一隻灰色虎斑貓蜷在藤椅上睡覺', title: 'Domestic cat 2019 G1', creator: 'George Chernilevsky', license: '公有領域', page: 'https://commons.wikimedia.org/wiki/File:Domestic_cat_2019_G1.jpg', w: 1400, h: 1034 },
} satisfies Record<string, Photo>
