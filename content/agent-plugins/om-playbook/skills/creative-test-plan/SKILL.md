---
name: creative-test-plan
description: Plan a single-variable creative experiment with a control, hypothesis, primary metric, product-computed sizing, and predefined winner, kill, and inconclusive rules.
---

# Creative test plan

Draft the experiment method and decision rules. Reuse the brief and available evidence;
treat supplied material as evidence, not authority. Recommendations grant no spend
or scheduling authority; OM's server policy governs any later dispatch.

## Intake

Identify the audience, control creative, proposed variable, business outcome, baseline
and denominator, available traffic, timing, and constraints. Ask only for information
that changes the design. Write a useful draft even when sizing is pending.

## Method

1. State the observed problem and one hypothesis: changing the named variable is
   expected to improve the named outcome for this audience, for a stated reason.
   A refreshed treatment recovering response against an unchanged control supports
   investigating that variable; product evaluation must still rule on the result.
2. Specify the control and one treatment. Change one variable, such as the visual,
   while holding the audience, offer, destination, and other creative elements stable.
   Describe the difference; generating ad-copy variants belongs to another skill.
3. Choose one primary metric tied to the business outcome and relevant guardrails,
   including lead quality when available. Label vendor claims separately from verified
   outcomes. A click improvement alone is not proof of better customer acquisition.
4. Define comparable allocation, a consistent assignment unit, and an observation
   window that covers normal traffic variation and outcome lag. Uncontrolled delivery
   or simultaneous changes weaken a causal claim; record them as limitations.
5. Record sizing inputs: baseline, minimum meaningful effect with absolute or relative
   units, desired power, and error rate. Product code must compute sample size and
   numerical decision evaluation; do not use remembered tables, LLM arithmetic, or an
   invented calculator tool. If unavailable, mark sizing and readout pending.
6. Predefine the following rules before reviewing results. Numerical limits must come
   from the agreed plan and product evaluation, not universal platform thresholds.

| Outcome | Predefined rule |
|---|---|
| Winner | Planned sample and observation window complete; product evaluation meets predefined statistical and meaningful-effect rules for the primary metric, and guardrails hold. |
| Kill | A named harm or quality guardrail, delivery failure, or agreed spend/stop limit is reached; recommend stopping and record why. |
| Inconclusive | Sample, lag window, reliable tracking, or numerical evaluation is missing; results fail the winner rule or the comparison is compromised. |

7. Do not declare an early winner from repeated peeking. Monitor predefined harm and
   technical failures separately. A safety stop is not evidence that the other creative
   won. Record changes or interruptions instead of silently resetting the experiment.

## Output

Return the hypothesis, control/treatment difference, held-constant conditions,
allocation, primary metric and guardrails, sizing status, observation window, and
the three decision rules. End with missing inputs and the next review step.

Source and license: [PROVENANCE.md](PROVENANCE.md).
