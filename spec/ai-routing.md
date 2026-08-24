# ConstructionOS AI Routing and Agent Architecture

**Architecture version:** 1.0

## 1. Goals

The platform must be independent of any single AI model/provider. Routing must choose the best eligible capability for the task while accounting for quality, reliability, cost, latency, privacy and tool requirements.

## 2. Layering

```text
Domain capability / Agent
        ↓
Agent Runtime
        ↓
AI Gateway
        ↓
Task Router
        ↓
Provider Router
        ↓
Provider Adapter
        ↓
Model
```

## 3. Provider abstraction

Provider adapter interface must support:

- text generation;
- structured output;
- multimodal input where supported;
- tool calling;
- streaming;
- usage/cost metadata;
- timeout/retry;
- provider error normalization.

## 4. Initial provider set

- OpenRouter adapter;
- direct OpenAI adapter;
- direct Anthropic adapter;
- direct Google adapter;
- Z.ai adapter where supported;
- local inference adapter.

OpenRouter is the first routing integration but is not the system architecture's authority or exclusive path.

## 5. Routing policy

A routing decision evaluates:

```text
hard constraints
→ task class
→ capability requirements
→ data/privacy policy
→ jurisdiction/availability
→ historical task quality
→ reliability
→ latency
→ cost
→ fallback availability
```

Hard constraints eliminate ineligible models before quality ranking.

## 6. Task classes

Examples:

- extraction;
- document editing;
- spreadsheet transformation;
- code generation;
- multimodal/site inspection;
- long-context regulation review;
- engineering reasoning;
- estimating;
- bidding;
- maintenance diagnosis;
- planning/scheduling;
- adversarial review.

## 7. Agent contract

An agent declares:

- agent ID/version;
- task capabilities;
- required tools;
- output schema;
- security scope;
- preferred model class;
- verification policy;
- fallback policy.

## 8. Multi-model adjudication

For high-consequence tasks the runtime may invoke multiple independent agents/models and an adjudicator. The adjudicator cannot simply accept majority text; it must compare structured outputs/evidence and identify disagreement.

## 9. Tool calling

All material domain actions occur through typed tool contracts. LLM text cannot directly execute database mutations.

## 10. AI execution record

Persist:

- execution ID;
- agent ID/version;
- model/provider;
- route rationale;
- context/reference IDs;
- prompt/context digest;
- tool calls;
- output schema status;
- verification result;
- cost;
- latency;
- retries/failover;
- human approval status.

## 11. Model evaluation

The system maintains task-level model performance data and can use it in routing. Performance is measured by actual verification outcomes, not just self-reported model scores.

## 12. Safety/authority rules

- raw model output is untrusted;
- structured commands are validated;
- high-consequence actions require configured approval;
- provider failures must not silently change business semantics;
- if no eligible model can meet policy, the system returns `UNAVAILABLE/INSUFFICIENT_EVIDENCE` rather than fabricating certainty.
