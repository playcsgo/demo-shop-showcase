<?php

/**
 * 產生種子商品的示意圖（自己畫的，不是網路上的圖）：php database/seed-assets/generate.php
 *   輸出 database/seed-assets/products/<SKU>.png（800×600），已 commit；改了設計才需要重跑
 *   需要 GD（含 FreeType）和一個有中文字的字型（預設 macOS 的 Arial Unicode，可用 SEED_FONT 指定）
 * 種子資料灌進去時由 products:seed-images 上傳到 S3（DatabaseSeeder、sandbox:data 都會呼叫）
 */
$font = getenv('SEED_FONT') ?: '/Library/Fonts/Arial Unicode.ttf';
if (! is_file($font)) {
    fwrite(STDERR, "找不到字型：{$font}（用 SEED_FONT=/path/to/font.ttf 指定）\n");
    exit(1);
}

// 品牌色（和前台 .brand-AK／SB／BC／MT 同一組）：[品牌名, 深色, 淺色背景]
$brands = [
    'AK' => ['秋田工作室', [180, 83, 9], [254, 243, 199]],
    'SB' => ['柴犬手作坊', [21, 128, 61], [220, 252, 231]],
    'BC' => ['藍貓咖啡', [37, 99, 235], [219, 234, 254]],
    'MT' => ['喵玩具', [190, 24, 93], [252, 231, 243]],
];

// 和 seed-assets/catalog 的商品一致，一個商品一張圖，檔名用該商品的第一個 SKU：[SKU, 品牌, 名稱, 圖上的大字]
$products = [
    ['DCS-DCAN-BEEF-165', 'SB', '成犬鮮肉主食罐', '罐'],
    ['DCS-CAL-60', 'SB', '鈣質嚼錠', '鈣'],
    ['DCS-DH-M', 'AK', '陶朱隱園', '屋'],
    ['DCS-SVC-HEALTH', 'AK', '寵物醫院健康檢查', '診'],
    ['DCS-FD-CHK-80', 'BC', '貓咪凍乾生食主食', '凍'],
    ['DCS-CAN-DUCK-80', 'BC', '鮮肉主食罐', '肉'],
    ['DCS-LPC-CHK-80', 'BC', '低磷低蛋白主食罐', '腎'],
    ['DCS-KIB-1500', 'BC', '無穀貓乾糧', '糧'],
    ['DCS-GRASS-3', 'BC', '貓草栽培盒', '草'],
    ['DCS-PRO-30', 'BC', '寵物益生菌', '菌'],
    ['DCS-JNT-60', 'BC', '關節保養粉', '節'],
    ['DCS-FISH-60', 'BC', '寵物魚油膠囊', '魚'],
    ['DCS-LIT-1', 'MT', '豆腐貓砂', '砂'],
    ['DCS-MAT-1', 'MT', '舔食墊', '舔'],
    ['DCS-WAND-1', 'MT', '羽毛逗貓棒', '棒'],
];

const W = 800, H = 600, S = 2;   // 先畫 2 倍大再縮小：GD 的圓沒有反鋸齒，縮小後邊緣才平滑

$out = __DIR__.'/products';
@mkdir($out, 0755, true);

foreach ($products as [$sku, $brand, $name, $glyph]) {
    [$brandName, $dark, $light] = $brands[$brand];
    $im = imagecreatetruecolor(W * S, H * S);

    // 背景：淺色往白色的直向漸層
    for ($y = 0; $y < H * S; $y++) {
        $t = $y / (H * S);
        $c = array_map(fn ($a) => (int) round($a + (255 - $a) * $t * 0.6), $light);
        imageline($im, 0, $y, W * S, $y, imagecolorallocate($im, ...$c));
    }

    // 淡淡的腳印（位置用 SKU 決定，每張不一樣、重跑結果一樣）
    mt_srand(crc32($sku));
    $paw = imagecolorallocatealpha($im, ...[...$dark, 112]);
    for ($i = 0; $i < 7;) {
        [$x, $y] = [mt_rand(40, W - 40), mt_rand(40, H - 40)];
        if (hypot($x - W / 2, $y - 250) < 210 || (abs($x - W / 2) < 280 && $y > 410)) {
            continue;   // 避開中間的圓和下面的文字
        }
        drawPaw($im, $x * S, $y * S, mt_rand(16, 30) * S, $paw);
        $i++;
    }

    // 中間的圓：白底、品牌色的大字
    $cx = W / 2 * S;
    $cy = 250 * S;
    imagefilledellipse($im, $cx, $cy + 8 * S, 300 * S, 300 * S, imagecolorallocatealpha($im, ...[...$dark, 100]));   // 陰影
    imagefilledellipse($im, $cx, $cy, 300 * S, 300 * S, imagecolorallocate($im, 255, 255, 255));
    centerText($im, 130 * S, $cx, $cy, $glyph, imagecolorallocate($im, ...$dark), $font);

    // 商品名稱、品牌
    centerText($im, 40 * S, $cx, 470 * S, $name, imagecolorallocate($im, 29, 35, 48), $font);
    centerText($im, 22 * S, $cx, 530 * S, "{$brandName} · Demo Shop", imagecolorallocate($im, ...$dark), $font);

    $small = imagecreatetruecolor(W, H);
    imagecopyresampled($small, $im, 0, 0, 0, 0, W, H, W * S, H * S);
    imagepng($small, "{$out}/{$sku}.png", 9);
    echo "{$out}/{$sku}.png\n";
}

/** 腳印：一個大肉球＋四個小肉球 */
function drawPaw(GdImage $im, int $x, int $y, int $r, int $color): void
{
    imagefilledellipse($im, $x, $y, (int) ($r * 2.2), (int) ($r * 1.8), $color);
    foreach ([[-1.15, -1.2], [-0.4, -1.75], [0.4, -1.75], [1.15, -1.2]] as [$dx, $dy]) {
        imagefilledellipse($im, (int) ($x + $dx * $r), (int) ($y + $dy * $r), (int) ($r * 0.9), (int) ($r * 1.1), $color);
    }
}

/** 文字以 (cx, cy) 為中心 */
function centerText(GdImage $im, float $size, int $cx, int $cy, string $text, int $color, string $font): void
{
    $box = imagettfbbox($size, 0, $font, $text);
    $w = $box[2] - $box[0];
    $h = $box[1] - $box[7];
    imagettftext($im, $size, 0, (int) ($cx - $w / 2 - $box[0]), (int) ($cy + $h / 2 - $box[1]), $color, $font, $text);
}
