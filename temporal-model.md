# ConstructionOS Temporal Model and Time Machine

**Architecture version:** 1.0

## 1. Purpose

The temporal system supports historical replay, backtesting, counterfactual analysis and learning without future leakage.

## 2. Time dimensions

Relevant records may contain:

- observed_at — when the value was observed;
- effective_from/effective_to — when it applied in the real world;
- published_at — when users could first know it;
- created_at — when ConstructionOS recorded it;
- superseded_at — when replaced.

## 3. Historical replay rule

For a replay timestamp T, the engine can only expose information whose publication/availability time is ≤ T, subject to the dataset's declared knowledge timestamp.

If source data is revised after T, replay uses the historical version that would have been available at T where such a snapshot exists.

## 4. Replay flow

```text
Experiment definition
        ↓
Historical timestamp T
        ↓
Build information snapshot
        ↓
Select model/data/tool versions
        ↓
Run prediction
        ↓
Store prediction
        ↓
Advance to outcome date
        ↓
Resolve prediction
        ↓
Update calibration metrics
```

## 5. Walk-forward validation

Historical training/evaluation must move forward through time rather than randomly mixing future data into training sets.

## 6. Counterfactuals

A scenario may modify:

- bid price;
- material price;
- supplier;
- design option;
- schedule;
- labor productivity;
- weather assumptions;
- maintenance strategy.

Counterfactual outputs must be labelled as simulated, not observed history.

## 7. Prediction ledger

Every prediction receives an immutable record before the future outcome is known.

The ledger must preserve:

- timestamp;
- input snapshot;
- model/tool versions;
- prediction distribution;
- assumptions;
- confidence;
- outcome later observed;
- error/calibration.

## 8. Synthetic data

Synthetic observations must be explicitly marked `SYNTHETIC` and never silently merged with observed/project data.

## 9. Historical market data

Time Machine datasets may include:

- material prices;
- labor rates;
- equipment rates;
- exchange rates;
- inflation;
- fuel;
- supplier performance;
- tender awards;
- competitor behavior;
- weather/climate conditions;
- project outcomes.

## 10. Adversarial leakage tests

The test suite must include records deliberately published after T to ensure replay excludes them.
