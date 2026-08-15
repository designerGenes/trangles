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

// SimpleWeight is what one single-score estimate counts for next to a full
// shape. A slider answers one question where a shape answers one per aspect, so
// it carries less information and moves the result less — but it is a real
// estimate from a real person and it still moves it.
const SimpleWeight = 0.6

var fibScale = []struct {
	limit  float64
	points int
}{
	{1.3, 1}, {2.6, 2}, {4.2, 3}, {6.2, 5}, {8.2, 8}, {math.MaxFloat64, 13},
}

type NamedShape struct {
	ID     string    `json:"id,omitempty"`
	Name   string    `json:"name"`
	Values []float64 `json:"values"`
}

// NamedScore is one estimate given as a single composite number rather than a
// shape — what "simple pointing" mode submits. It sits on the same 1..max scale
// the aspects use, which is the only reason the two can be averaged together.
type NamedScore struct {
	ID    string  `json:"id,omitempty"`
	Name  string  `json:"name"`
	Score float64 `json:"score"`
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
	Scores       []NamedScore `json:"scores,omitempty"`
}

// shapesOf returns only the estimates that carry a value per aspect. A
// single-score estimate has no polygon to draw and no per-aspect opinion to
// average, so it is deliberately absent from everything built on shapes.
func shapesOf(subs map[string]*Submission) []NamedShape {
	out := make([]NamedShape, 0, len(subs))
	for id, s := range subs {
		if s.Mode == ModeSimple {
			continue
		}
		out = append(out, NamedShape{ID: id, Name: s.Name, Values: s.Values})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// scoresOf returns the estimates given as one composite number.
func scoresOf(subs map[string]*Submission) []NamedScore {
	out := make([]NamedScore, 0, len(subs))
	for id, s := range subs {
		if s.Mode != ModeSimple {
			continue
		}
		out = append(out, NamedScore{ID: id, Name: s.Name, Score: s.Score})
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

func computeSummary(shapes []NamedShape, scores []NamedScore, axes []string) *Summary {
	k := len(axes)
	n := len(shapes)
	m := len(scores)
	sum := &Summary{
		Averages: make([]float64, k),
		Spread:   make([]float64, k),
		Shapes:   shapes,
		Scores:   scores,
	}
	if n == 0 && m == 0 {
		sum.PointsWhy = "No estimates were submitted."
		sum.Observations = []string{"No estimates came in this round."}
		return sum
	}

	// Averages and population stddev per axis. Only shapes have a per-aspect
	// opinion; with none of them there is nothing honest to print per aspect,
	// so the rows are dropped rather than filled with zeroes.
	if n == 0 {
		sum.Averages = nil
		sum.Spread = nil
	} else {
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
	}

	// Outliers: distance from the centroid, flagged when clearly beyond
	// the group's typical distance. Needs at least 3 shapes to mean anything.
	if n >= 3 && sum.Averages != nil {
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

	// Story points: every estimate reduces to one number on the shared aspect
	// scale — a shape through the aspect weights, a single score directly — and
	// the two are averaged with the shapes counting for more. With no single
	// scores in play the arithmetic collapses to exactly the shape-only blend.
	weights := weightsFor(axes)
	shapeBase := 0.0
	for i, a := range sum.Averages {
		shapeBase += weights[i] * a
	}
	scoreTotal := 0.0
	for _, s := range scores {
		scoreTotal += s.Score
	}
	shapeMass := float64(n)
	scoreMass := SimpleWeight * float64(m)
	base := shapeBase
	if shapeMass+scoreMass > 0 {
		base = (shapeMass*shapeBase + SimpleWeight*scoreTotal) / (shapeMass + scoreMass)
	}

	meanSpread := 0.0
	for _, sp := range sum.Spread {
		meanSpread += sp
	}
	if k > 0 && len(sum.Spread) > 0 {
		meanSpread /= float64(k)
	}
	// Single-score estimates can disagree with the room too, so their scatter
	// around the blended score earns the same upward nudge the aspects get.
	spreadTerm := meanSpread
	if m > 0 {
		scoreDev := 0.0
		for _, s := range scores {
			d := s.Score - base
			scoreDev += d * d
		}
		scoreDev = math.Sqrt(scoreDev / float64(m))
		spreadTerm = (shapeMass*meanSpread + scoreMass*scoreDev) / (shapeMass + scoreMass)
	}

	adjusted := base + disagreementFactor*spreadTerm
	for _, step := range fibScale {
		if adjusted <= step.limit {
			sum.StoryPoints = step.points
			break
		}
	}
	source := weightDescription(axes, weights)
	if m > 0 {
		source = fmt.Sprintf("%s, blended with %d single-score estimate%s at %d%% weight",
			source, m, plural(m), int(SimpleWeight*100))
	}
	bump := adjusted - base
	if bump >= 0.05 {
		sum.PointsWhy = fmt.Sprintf(
			"%s scores %.1f, +%.1f because the team disagrees -> %d points.",
			source, base, bump, sum.StoryPoints)
	} else {
		sum.PointsWhy = fmt.Sprintf(
			"%s scores %.1f -> %d points.",
			source, base, sum.StoryPoints)
	}

	sum.Observations = observations(sum, n, axes, scores, shapeBase)
	for i := range sum.Averages {
		sum.Averages[i] = round1(sum.Averages[i])
	}
	for i := range sum.Spread {
		sum.Spread[i] = round1(sum.Spread[i])
	}
	return sum
}

func observations(s *Summary, n int, axes []string, scores []NamedScore, shapeBase float64) []string {
	var obs []string

	// Agreement / disagreement.
	maxSpread, maxAxis := 0.0, 0
	allTight := len(s.Spread) > 0
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

	// A room split between shapes and single scores is worth naming: the two
	// groups answered different questions and may not have noticed they
	// disagree, because only one of them is on the chart.
	if m := len(scores); m > 0 && n > 0 {
		scoreMean := 0.0
		for _, score := range scores {
			scoreMean += score.Score
		}
		scoreMean /= float64(m)
		if gap := scoreMean - shapeBase; math.Abs(gap) >= 1.5 {
			direction := "higher"
			if gap < 0 {
				direction = "lower"
			}
			obs = append(obs, fmt.Sprintf(
				"Single-score estimates came in %.1f %s than the shapes - worth asking what the chart is missing.",
				math.Abs(round1(gap)), direction))
		}
	}

	// The named guidance applies only to the standard issue-pointing aspects.
	if isDefaultAxes(axes) && len(s.Averages) == len(DefaultAxes) {
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

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
