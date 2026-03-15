package gomode

import "math"

// ColumnStats holds computed statistics for a numeric column.
type ColumnStats struct {
	Count    int     `json:"count"`
	Sum      float64 `json:"sum"`
	Mean     float64 `json:"mean"`
	Min      float64 `json:"min"`
	Max      float64 `json:"max"`
	Variance float64 `json:"variance"`
	StdDev   float64 `json:"stddev"`
}

// Stats computes full statistics for a float64 column using SIMD.
func Stats(col []float64) ColumnStats {
	n := len(col)
	if n == 0 {
		return ColumnStats{}
	}
	sum := SumF64(col)
	min, max := MinMaxF64(col)
	mean := sum / float64(n)
	dotXX := DotF64(col, col)
	variance := dotXX/float64(n) - mean*mean
	return ColumnStats{
		Count:    n,
		Sum:      sum,
		Mean:     mean,
		Min:      min,
		Max:      max,
		Variance: variance,
		StdDev:   math.Sqrt(variance),
	}
}

// NormalizeColumn normalizes a column to [0,1] range in-place using SIMD.
func NormalizeColumn(col []float64) (min, max float64) {
	if len(col) == 0 {
		return 0, 0
	}
	min, max = MinMaxF64(col)
	rangeVal := max - min
	if rangeVal == 0 {
		for i := range col {
			col[i] = 0
		}
		return min, max
	}
	// col[i] = (col[i] - min) / range = col[i] * (1/range) + (-min/range)
	MapLinearF64(col, 1.0/rangeVal, -min/rangeVal)
	return min, max
}

// Correlation computes Pearson correlation between two columns using SIMD.
// Returns r in [-1, 1].
func Correlation(a, b []float64) float64 {
	n := len(a)
	if n == 0 || len(b) == 0 {
		return 0
	}
	sumA := SumF64(a)
	sumB := SumF64(b)
	meanA := sumA / float64(n)
	meanB := sumB / float64(n)

	dotAB := DotF64(a, b)
	dotAA := DotF64(a, a)
	dotBB := DotF64(b, b)

	// cov = E[AB] - E[A]*E[B]
	cov := dotAB/float64(n) - meanA*meanB
	// stdA = sqrt(E[A^2] - E[A]^2)
	varA := dotAA/float64(n) - meanA*meanA
	varB := dotBB/float64(n) - meanB*meanB

	denom := math.Sqrt(varA * varB)
	if denom == 0 {
		return 0
	}
	return cov / denom
}

// WeightedSum computes sum(data[i] * weights[i]) using SIMD dot product.
func WeightedSum(data, weights []float64) float64 {
	return DotF64(data, weights)
}
