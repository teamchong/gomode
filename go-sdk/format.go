package gomode

// FormatFloat formats a float64 to a string with up to 2 decimal places.
// Uses no stdlib — safe for TinyGo WASM.
func FormatFloat(f float64) string {
	if f == 0 {
		return "0"
	}
	neg := false
	if f < 0 {
		neg = true
		f = -f
	}
	whole := int64(f)
	frac := int64((f - float64(whole)) * 100)

	s := formatInt(whole)
	if frac > 0 {
		s += "." + formatInt(frac)
	}
	if neg {
		s = "-" + s
	}
	return s
}

// FormatInt formats an int64 to a string.
func FormatInt(n int64) string {
	if n == 0 {
		return "0"
	}
	if n < 0 {
		return "-" + formatInt(-n)
	}
	return formatInt(n)
}

func formatInt(n int64) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
