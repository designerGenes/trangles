package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestComputeSummaryUsesEqualWeightsForCustomAspects(t *testing.T) {
	axes := []string{"Risk", "Impact", "Effort", "Reach"}
	summary := computeSummary([]NamedShape{
		{Name: "Ada", Values: []float64{2, 4, 6, 8}},
		{Name: "Lin", Values: []float64{4, 6, 8, 10}},
	}, nil, axes)
	if got, want := summary.Averages, []float64{3, 5, 7, 9}; !sameValues(got, want) {
		t.Fatalf("averages = %#v, want %#v", got, want)
	}
	if summary.StoryPoints != 8 {
		t.Fatalf("story points = %d, want 8", summary.StoryPoints)
	}
	if !strings.HasPrefix(summary.PointsWhy, "Equal-weight blend of") {
		t.Fatalf("custom summary did not describe equal weighting: %q", summary.PointsWhy)
	}
}

func TestComputeSummaryFlagsAnOutlierByCustomAspect(t *testing.T) {
	axes := []string{"Risk", "Impact"}
	summary := computeSummary([]NamedShape{
		{Name: "Ada", Values: []float64{4, 4}},
		{Name: "Lin", Values: []float64{4, 4}},
		{Name: "Mia", Values: []float64{10, 4}},
	}, nil, axes)
	if len(summary.Outliers) != 1 {
		t.Fatalf("outliers = %#v", summary.Outliers)
	}
	if outlier := summary.Outliers[0]; outlier.Name != "Mia" || outlier.DrivenBy != "Risk" || outlier.Direction != "higher" {
		t.Fatalf("unexpected outlier: %#v", outlier)
	}
}

func TestSingleScoreEstimatesCountLessThanShapes(t *testing.T) {
	axes := []string{"Risk", "Impact"}
	shapes := []NamedShape{
		{Name: "Ada", Values: []float64{4, 4}},
		{Name: "Lin", Values: []float64{4, 4}},
	}

	// With nobody in simple mode the arithmetic must be exactly what it was
	// before the mode existed — the feature costs existing sessions nothing.
	shapesOnly := computeSummary(shapes, nil, axes)
	if shapesOnly.PointsWhy != computeSummary(shapes, []NamedScore{}, axes).PointsWhy {
		t.Fatal("an empty score list changed the result")
	}

	// One person sliding to 8 pulls the blend up, but less than a third shape
	// at 8 would: 0.6 of a vote, not a whole one.
	withScore := computeSummary(shapes, []NamedScore{{Name: "Mia", Score: 8}}, axes)
	asShape := computeSummary(append(append([]NamedShape(nil), shapes...),
		NamedShape{Name: "Mia", Values: []float64{8, 8}}), nil, axes)
	if !(withScore.StoryPoints >= shapesOnly.StoryPoints) {
		t.Fatalf("a high single score should not lower the result: %d vs %d",
			withScore.StoryPoints, shapesOnly.StoryPoints)
	}
	base := pointsBase(t, withScore)
	shapeBase := pointsBase(t, asShape)
	if base >= shapeBase {
		t.Fatalf("a single score pulled as hard as a shape: %.2f vs %.2f", base, shapeBase)
	}
	if !strings.Contains(withScore.PointsWhy, "single-score") {
		t.Fatalf("the explanation hides the blend: %q", withScore.PointsWhy)
	}
	if len(withScore.Scores) != 1 {
		t.Fatalf("scores were not reported: %#v", withScore.Scores)
	}
}

func TestScoreOnlyRoundDropsPerAspectRowsRatherThanPrintingZeroes(t *testing.T) {
	summary := computeSummary(nil, []NamedScore{{Name: "Ada", Score: 5}, {Name: "Lin", Score: 5}},
		[]string{"Risk", "Impact"})
	if summary.Averages != nil || summary.Spread != nil {
		t.Fatalf("per-aspect figures were invented from nothing: %#v / %#v", summary.Averages, summary.Spread)
	}
	if summary.StoryPoints == 0 {
		t.Fatal("single scores alone should still produce a result")
	}
}

// pointsBase reads the blended score back out of the explanation, which is the
// only place it is exposed.
func pointsBase(t *testing.T, summary *Summary) float64 {
	t.Helper()
	var value float64
	if _, err := fmt.Sscanf(summary.PointsWhy[strings.LastIndex(summary.PointsWhy, "scores ")+7:], "%f", &value); err != nil {
		t.Fatalf("could not read the base out of %q: %v", summary.PointsWhy, err)
	}
	return value
}
