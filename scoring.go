package main

import (
	"fmt"
	"math"
	"sort"
)

// Weights: uncertainty inflates an estimate more than complexity, which
// inflates it more than toil. Indexes match DefaultAxes.
var axisWeights = []float64{0.40, 0.35, 0.25}

// disagreementFactor: how strongly spread (i.e. the team not agreeing)
// pushes the score upward. Disagreement is itself a form of uncertainty.
const disagreementFactor = 0.35

var fibScale = []struct {
	limit  float64
	points int
}{
	{1.3, 1}, {2.6, 2}, {4.2, 3}, {6.2, 5}, {8.2, 8}, {math.MaxFloat64, 13},
}

type NamedShape struct {
	Name   string    `json:"name"`
	Values []float64 `json:"values"`
}

type Outlier struct {
	Name      string  `json:"name"`
	Distance  float64 `json:"distance"`
	DrivenBy  string  `json:"drivenBy"`
	Direction string  `json:"direction"` // "higher" | "lower"
}

type Summary struct {
	Averages     []float64    `json:"averages"`
	Spread       []float64    `json:"spread"` // population stddev per axis
	StoryPoints  int          `json:"storyPoints"`
	PointsWhy    string       `json:"pointsWhy"`
	Outliers     []Outlier    `json:"outliers"`
	Observations []string     `json:"observations"`
	Shapes       []NamedShape `json:"shapes"`
}

func shapesOf(subs map[string]*Submission) []NamedShape {
	out := make([]NamedShape, 0, len(subs))
	for _, s := range subs {
		out = append(out, NamedShape{Name: s.Name, Values: s.Values})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func axisAverages(shapes []NamedShape, axisCount int) []float64 {
	avg := make([]float64, axisCount)
	if len(shapes) == 0 {
		return avg
	}
	for _, s := range shapes {
		for i, v := range s.Values {
			avg[i] += v
		}
	}
	for i := range avg {
		avg[i] = round1(avg[i] / float64(len(shapes)))
	}
	return avg
}

func computeSummary(shapes []NamedShape, axes []string) *Summary {
	k := len(axes)
	n := len(shapes)
	sum := &Summary{
		Averages: make([]float64, k),
		Spread:   make([]float64, k),
		Shapes:   shapes,
	}
	if n == 0 {
		sum.PointsWhy = "No estimates were submitted."
		sum.Observations = []string{"No estimates came in this round."}
		return sum
	}

	// Averages and population stddev per axis.
	for _, s := range shapes {
		for i, v := range s.Values {
			sum.Averages[i] += v
		}
	}
	for i := range sum.Averages {
		sum.Averages[i] /= float64(n)
	}
	for _, s := range shapes {
		for i, v := range s.Values {
			d := v - sum.Averages[i]
			sum.Spread[i] += d * d
		}
	}
	for i := range sum.Spread {
		sum.Spread[i] = math.Sqrt(sum.Spread[i] / float64(n))
	}

	// Outliers: distance from the centroid, flagged when clearly beyond
	// the group's typical distance. Needs at least 3 shapes to mean anything.
	if n >= 3 {
		dists := make([]float64, n)
		for i, s := range shapes {
			for j, v := range s.Values {
				d := v - sum.Averages[j]
				dists[i] += d * d
			}
			dists[i] = math.Sqrt(dists[i])
		}
		sorted := append([]float64(nil), dists...)
		sort.Float64s(sorted)
		median := sorted[n/2]
		if n%2 == 0 {
			median = (sorted[n/2-1] + sorted[n/2]) / 2
		}
		for i, s := range shapes {
			if dists[i] > 2.0 && dists[i] > 1.6*median {
				axis, dir := dominantDeviation(s.Values, sum.Averages, axes)
				sum.Outliers = append(sum.Outliers, Outlier{
					Name: s.Name, Distance: round1(dists[i]),
					DrivenBy: axis, Direction: dir,
				})
			}
		}
		sort.Slice(sum.Outliers, func(i, j int) bool {
			return sum.Outliers[i].Distance > sum.Outliers[j].Distance
		})
	}

	// Story points: weighted blend of the axes, nudged up by disagreement.
	weights := weightsFor(axes)
	base := 0.0
	for i, a := range sum.Averages {
		base += weights[i] * a
	}
	meanSpread := 0.0
	for _, sp := range sum.Spread {
		meanSpread += sp
	}
	if k > 0 {
		meanSpread /= float64(k)
	}
	adjusted := base + disagreementFactor*meanSpread
	for _, step := range fibScale {
		if adjusted <= step.limit {
			sum.StoryPoints = step.points
			break
		}
	}
	bump := adjusted - base
	if bump >= 0.05 {
		sum.PointsWhy = fmt.Sprintf(
			"%s scores %.1f, +%.1f because the team disagrees -> %d points.",
			weightDescription(axes, weights), base, bump, sum.StoryPoints)
	} else {
		sum.PointsWhy = fmt.Sprintf(
			"%s scores %.1f -> %d points.",
			weightDescription(axes, weights), base, sum.StoryPoints)
	}

	sum.Observations = observations(sum, n, axes)
	for i := range sum.Averages {
		sum.Averages[i] = round1(sum.Averages[i])
	}
	for i := range sum.Spread {
		sum.Spread[i] = round1(sum.Spread[i])
	}
	return sum
}

func observations(s *Summary, n int, axes []string) []string {
	var obs []string

	// Agreement / disagreement.
	maxSpread, maxAxis := 0.0, 0
	allTight := true
	for i, sp := range s.Spread {
		if sp > maxSpread {
			maxSpread, maxAxis = sp, i
		}
		if sp > 1.0 {
			allTight = false
		}
	}
	switch {
	case n >= 3 && maxSpread >= 2.2:
		obs = append(obs, fmt.Sprintf(
			"Wide split on %s (+/-%.1f) - the group sees this differently. Worth a short discussion before committing.",
			axes[maxAxis], maxSpread))
	case n >= 2 && allTight:
		obs = append(obs, "Strong agreement across all aspects.")
	}

	// The named guidance applies only to the standard issue-pointing aspects.
	if isDefaultAxes(axes) {
		u, c, t := s.Averages[0], s.Averages[1], s.Averages[2]
		switch {
		case u >= 6.5:
			obs = append(obs, "Uncertainty dominates - consider a spike or splitting the unknowns into their own issue.")
		case u <= 3.0 && c >= 6.5:
			obs = append(obs, "Well understood but heavy: mostly an engineering-time problem, not a research one.")
		case t >= 6.5 && c <= 4.0:
			obs = append(obs, "Reads as grunt work - low risk. A candidate to split up or automate.")
		case u <= 2.5 && c <= 2.5 && t <= 2.5:
			obs = append(obs, "Small on every axis - likely a quick win.")
		}
	}

	// Outliers get a voice instead of peer pressure.
	for _, o := range s.Outliers {
		obs = append(obs, fmt.Sprintf(
			"%s's shape sits farthest from the group, driven by %s %s than the rest - worth hearing why before settling.",
			o.Name, o.Direction, o.DrivenBy))
	}
	if len(obs) > 4 {
		obs = obs[:4]
	}
	return obs
}

func dominantDeviation(values, avg []float64, axes []string) (axis, direction string) {
	best, bi := 0.0, 0
	for i, v := range values {
		d := math.Abs(v - avg[i])
		if d > best {
			best, bi = d, i
		}
	}
	direction = "higher"
	if values[bi] < avg[bi] {
		direction = "lower"
	}
	return axes[bi], direction
}

func weightsFor(axes []string) []float64 {
	if isDefaultAxes(axes) {
		return append([]float64(nil), axisWeights...)
	}
	weights := make([]float64, len(axes))
	if len(weights) == 0 {
		return weights
	}
	for i := range weights {
		weights[i] = 1 / float64(len(weights))
	}
	return weights
}

func weightDescription(axes []string, weights []float64) string {
	if isDefaultAxes(axes) {
		return fmt.Sprintf("Weighted blend of the axes (%.0f%% / %.0f%% / %.0f%%)",
			weights[0]*100, weights[1]*100, weights[2]*100)
	}
	return fmt.Sprintf("Equal-weight blend of %d aspects", len(axes))
}

func isDefaultAxes(axes []string) bool {
	if len(axes) != len(DefaultAxes) {
		return false
	}
	for i := range axes {
		if axes[i] != DefaultAxes[i] {
			return false
		}
	}
	return true
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
