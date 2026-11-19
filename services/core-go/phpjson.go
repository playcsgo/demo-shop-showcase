package main

import (
	"fmt"
	"strconv"
	"strings"
)

// PHP json_encode 的預設輸出（斜線跳脫成 \/、非 ASCII 跳脫成 \uXXXX）。
// 冪等鍵的 request_hash 是 sha256(json_encode($utm))：兩邊算出來要一樣，同一個 key 在 PHP、Go 之間重送才會被認出來
func phpJSONEncode(o ordered) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, x := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(phpJSONString(x.k))
		b.WriteByte(':')
		switch val := x.v.(type) {
		case nil:
			b.WriteString("null")
		case string:
			b.WriteString(phpJSONString(val))
		case int:
			b.WriteString(strconv.Itoa(val))
		default:
			b.WriteString(phpJSONString(fmt.Sprint(val)))
		}
	}
	b.WriteByte('}')
	if len(o) == 0 {
		return "[]" // PHP 的空陣列 json_encode 是 []
	}
	return b.String()
}

func phpJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '/':
			b.WriteString(`\/`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		case r < 0x80:
			b.WriteRune(r)
		case r > 0xFFFF:
			r -= 0x10000
			fmt.Fprintf(&b, `\u%04x\u%04x`, 0xD800+(r>>10), 0xDC00+(r&0x3FF))
		default:
			fmt.Fprintf(&b, `\u%04x`, r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
