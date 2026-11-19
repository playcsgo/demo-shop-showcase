package main

// 拆包裹（和 PHP 的 ShipmentPlanner 相同）：依 shipping_class，不依品牌
//
//	standard：同單合併一個包裹｜litter：獨立一個包裹｜bulky：每件一個包裹｜service：不出貨
//
// 順序：standard 在最前、litter 其次、bulky 照明細順序
var shippingFees = map[string]int{"standard": 80, "litter": 120, "bulky": 1500}

func carrierOf(class string) string {
	switch class {
	case "standard", "litter":
		return "home_delivery"
	case "bulky":
		return "bulky_freight"
	}
	return ""
}

type planLine struct {
	key       int64 // order_item 的 id（結帳算運費時還沒有，填 0）
	variantID int64
	qty       int
	class     string
}

type pkg struct {
	class   string
	carrier string
	fee     int
	lines   []planLine
}

func planShipments(lines []planLine) []pkg {
	var standard, litter []planLine
	var bulky []pkg
	for _, l := range lines {
		switch l.class {
		case "standard":
			standard = append(standard, l)
		case "litter":
			litter = append(litter, l)
		case "bulky":
			for range l.qty {
				one := l
				one.qty = 1
				bulky = append(bulky, newPkg("bulky", []planLine{one}))
			}
		}
	}
	var out []pkg
	if len(standard) > 0 {
		out = append(out, newPkg("standard", standard))
	}
	if len(litter) > 0 {
		out = append(out, newPkg("litter", litter))
	}
	return append(out, bulky...)
}

func newPkg(class string, lines []planLine) pkg {
	return pkg{class, carrierOf(class), shippingFees[class], lines}
}

func totalFee(pkgs []pkg) int {
	sum := 0
	for _, p := range pkgs {
		sum += p.fee
	}
	return sum
}
