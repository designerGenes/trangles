package main

import (
	"strings"
	"testing"
)

func TestComputeSummaryUsesEqualWeightsForCustomAspects(t *testing.T) {
	axes := []string{"Risk", "Impact", "Effort", "Reach"}
	summary := computeSummary([]NamedShape{
		{Name: "Ada", Values: []float64{2, 4, 6, 8}},
		{Name: "Lin", Values: []float64{4, 6, 8, 10}},
	}, axes)
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
	}, axes)
	if len(summary.Outliers) != 1 {
		t.Fatalf("outliers = %#v", summary.Outliers)
	}
	if outlier := summary.Outliers[0]; outlier.Name != "Mia" || outlier.DrivenBy != "Risk" || outlier.Direction != "higher" {
		t.Fatalf("unexpected outlier: %#v", outlier)
	}
}
