<?php

namespace App\Filament\Resources\Products\Schemas;

use App\Enums\ShippingClass;
use App\Filament\Support\BrandScope;
use App\Models\ProductVariant;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TagsInput;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Components\Utilities\Get;
use Filament\Schemas\Schema;

class ProductForm
{
    public const DELIVERY_MODES = ['direct' => '直送', 'warehouse' => '寄倉', 'subscription' => '訂閱', 'booking' => '預約（服務）'];

    public const SHIPPING_CLASSES = ['standard' => '一般（同單合併）', 'litter' => '貓砂（獨立包裹）', 'bulky' => '大型（每件獨立）', 'service' => '服務（不出貨）'];

    /** 服務（健康檢查、美容）不出貨、沒有庫存 */
    private static function isService(mixed $class): bool
    {
        return ($class instanceof ShippingClass ? $class->value : $class) === ShippingClass::Service->value;
    }

    /** 熱賣模式的狀態：誰開的、什麼時候開的、現在實際幾桶 */
    public static function hotStatus(ProductVariant $variant): ?string
    {
        $stock = $variant->stock();
        if (! $stock) {
            return null;
        }
        $mode = ['off' => '一般', 'manual' => '熱賣中（手動）', 'auto' => '熱賣中（系統自動）'][$variant->hot_mode] ?? $variant->hot_mode;
        $since = $variant->hot_since ? '，'.$variant->hot_since->timezone('Asia/Taipei')->format('m/d H:i').' 開啟' : '';

        return "{$mode}{$since}・目前 {$stock->buckets} 桶";
    }

    public static function configure(Schema $schema): Schema
    {
        return $schema->columns(1)->components([
            Section::make('商品')->columns(2)->schema([
                // 選項只列出自己的品牌；Filament 的 Select 也會在伺服器端驗證值必須在選項內 → 改不到別人的品牌
                Select::make('brand_id')->label('品牌')->options(fn () => BrandScope::brandOptions())->required(),
                TextInput::make('name')->label('名稱')->required()->maxLength(255),
                Select::make('status')->label('狀態')->options(['active' => '上架', 'inactive' => '下架'])->default('active')->required(),
                CheckboxList::make('delivery_modes')->label('允許的交付方式')->options(self::DELIVERY_MODES)->required()->columns(2),
                // 圖片存 S3、資料庫只存路徑：core-api 在 K8s 有 2～8 個 Pod，存 Pod 的硬碟別的 Pod 看不到（Pod 重建也會清空）
                // 只收點陣圖（不收 SVG：SVG 可以夾 script），上限 5 MB；visibility public 只是讓預覽用 s3 disk 的 url（/media/...）
                FileUpload::make('image_path')->label('商品圖片')->columnSpanFull()
                    ->image()->acceptedFileTypes(['image/jpeg', 'image/png', 'image/webp'])->maxSize(5 * 1024)
                    ->imageEditor()
                    ->disk('s3')->directory('products')->visibility('public'),
            ]),
            // AI 客服和前台商品頁讀這些（AIC-011）；數字不寫在這裡，放在規格與價格
            Section::make('商品介紹')->columns(2)->collapsible()->schema([
                TextInput::make('slug')->label('代號（英文）')->maxLength(60)->unique(ignoreRecord: true)
                    ->regex('/^[a-z0-9-]+$/')->helperText('AI 客服用來指這個商品，例如 tofu-litter'),
                TextInput::make('category')->label('類別')->maxLength(20),
                CheckboxList::make('species')->label('適用')->options(['cat' => '貓', 'dog' => '狗'])->columns(2),
                TagsInput::make('concerns')->label('保健需求')->placeholder('digestive、kidney…'),
                TagsInput::make('warnings')->label('不適用的情況')->columnSpanFull()->placeholder('一條一句'),
                Textarea::make('description_md')->label('介紹（Markdown）')->rows(8)->columnSpanFull(),
            ]),
            Section::make('規格與價格')->schema([
                Repeater::make('variants')->relationship()->label('')->columns(6)->defaultItems(1)->schema([
                    TextInput::make('sku')->required()->maxLength(40),
                    TextInput::make('name')->label('規格名稱')->required(),
                    TextInput::make('flavor')->label('口味')->maxLength(30),
                    TextInput::make('size_label')->label('規格')->maxLength(30),
                    TextInput::make('price')->label('價格（元）')->numeric()->minValue(0)->required(),
                    Select::make('shipping_class')->label('運送類別')->options(self::SHIPPING_CLASSES)->required()->live(),
                    // 庫存不是規格的欄位（存在 inventory 表）：不跟著規格存（dehydrated false），
                    // 存檔後由頁面用「增減」的方式套用（Pages/Concerns/AppliesStockChanges）
                    TextInput::make('stock_change')
                        ->label(fn (?ProductVariant $record) => $record ? '增減庫存' : '庫存')
                        ->integer()
                        ->placeholder(fn (?ProductVariant $record) => $record ? '+入庫／−盤損' : '0')
                        ->helperText(fn (?ProductVariant $record) => ($stock = $record?->stock())
                            ? "在庫 {$stock->on_hand}，已預留 {$stock->reserved}，可賣 {$stock->available()}" : null)
                        ->hidden(fn (Get $get) => self::isService($get('shipping_class')))
                        ->dehydrated(false),
                    Toggle::make('is_litter')->label('貓砂'),
                    // 熱賣模式：大量同時下單時庫存分散到好幾桶，不用排隊等同一列（InventoryBuckets）
                    // 一樣不是規格的欄位：存檔後改「想要幾桶」，core-scheduler 5 秒內拆好，不用重新部署
                    Toggle::make('hot')->label('熱賣模式')
                        ->afterStateHydrated(fn (Toggle $component, ?ProductVariant $record) => $component->state(($record?->bucket_target ?? 1) > 1))
                        ->helperText(fn (?ProductVariant $record) => $record ? self::hotStatus($record) : null)
                        ->hidden(fn (Get $get) => self::isService($get('shipping_class')))
                        ->dehydrated(false),
                ]),
            ]),
        ]);
    }
}
