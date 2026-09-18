'use strict';

const { RandomForestRegression } = require('ml-random-forest');

// Verified against ml-random-forest 2.1.0 source: RandomForestRegression exposes
// predict(X) for the ensemble's point estimate, and predictionValues(X) for the
// per-tree predictions (used here to derive a confidence from tree agreement).
const FOREST_OPTIONS = {
  nEstimators: 40,
  seed: 42,
};

const MAX_STD_DEV_FOR_ZERO_CONFIDENCE = 100; // minutes

class ForestModel {
  constructor() {
    this.forest = null;
  }

  train(rows) {
    if (!rows || rows.length < 5) {
      this.forest = null;
      return;
    }
    const X = rows.map((r) => r.features);
    const y = rows.map((r) => r.label);
    const forest = new RandomForestRegression(FOREST_OPTIONS);
    forest.train(X, y);
    this.forest = forest;
  }

  isReady() {
    return !!this.forest;
  }

  /**
   * Returns { minuteOfDay, confidence } or null if not trained.
   */
  predict(features) {
    if (!this.forest) return null;

    const [minuteOfDay] = this.forest.predict([features]);
    const perTree = this.forest.predictionValues([features]).getRow(0);

    const mean = perTree.reduce((sum, v) => sum + v, 0) / perTree.length;
    const variance = perTree.reduce((sum, v) => sum + (v - mean) ** 2, 0) / perTree.length;
    const stdDevMinutes = Math.sqrt(variance);

    // Tight agreement across trees (a few minutes apart) -> high confidence;
    // wide spread across trees -> low confidence.
    const confidence = Math.max(
      0,
      Math.min(100, Math.round(100 * (1 - stdDevMinutes / MAX_STD_DEV_FOR_ZERO_CONFIDENCE))),
    );

    return { minuteOfDay, confidence };
  }
}

module.exports = ForestModel;
