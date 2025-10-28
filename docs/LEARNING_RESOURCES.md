# Learning Resources for LLM Evaluation & Statistical Analysis

## Context

This guide is for learning how to evaluate LLMs properly, with a focus on:
- Statistical experimental design for parameter sweeps
- LLM-specific evaluation methodologies
- Analyzing results from agentic tasks (like maze navigation)

## Quick Start (Already Subscribed to O'Reilly)

### Recommended Learning Path

**Week 1: Foundation**
- **Day 1-2**: Watch "A/B Testing, A Data Science Perspective" by Lisa Qian (2 hours)
- **Day 3**: Read "Data Science from Scratch" Chapter 7 (1 hour)
- **Day 4-5**: Watch "Evaluating Large Language Models (LLMs)" (2 hours)

**Week 2: Depth**
- **Day 1-2**: Read "LLM Engineer's Handbook" Chapter 7 (2 hours)
- **Day 3-4**: Read "Design and Analysis of Experiments" Chapter 5 (3 hours)
- **Day 5**: Read "Statistics in a Nutshell" - Multiple Comparisons section (30 min)

**Week 3: Application**
- Write analysis scripts for parameter sweep
- Run statistical tests on experimental data
- Create visualizations and interpret results

---

## O'Reilly Resources (Prioritized)

### 🎯 Most Relevant for Parameter Sweeps

#### 1. **"A/B Testing, A Data Science Perspective"** by Lisa Qian (Airbnb) 📹
- **URL**: oreilly.com/library/view/ab-testing-a/9781491934777/
- **Time**: 2 hours
- **Why Critical**: Your parameter sweep IS an A/B test (12 variants)
- **What You'll Learn**:
  - Sample size calculation
  - Statistical significance
  - Multiple comparisons problem (testing 12 configs)
  - When to stop testing
- **Action**: Watch first, as this provides the foundation for comparing configs

#### 2. **"Evaluating Large Language Models (LLMs)"** 📹
- **URL**: oreilly.com/videos/evaluating-large-language/9780135451922/
- **Time**: 2 hours
- **Topics**:
  - Reference-free vs reference-based evaluation
  - Benchmarks: MMLU, MTEB, TruthfulQA (skip these sections)
  - Real-world scenarios: chatbots, RAG systems
  - Probing techniques
- **Focus On**: Real-world scenarios section - translates to agentic tasks
- **Skip**: Academic benchmarks (not relevant for custom tasks)

#### 3. **"LLM Engineer's Handbook"** - Chapter 7: Evaluating LLMs 📚
- **URL**: oreilly.com/library/view/llm-engineers-handbook/9781836200079/Text/Chapter_07.xhtml
- **Time**: 2 hours
- **Topics**:
  - ML vs LLM evaluation differences
  - General-purpose vs domain-specific evaluations
  - RAG evaluation using Ragas and ARES
  - Task-specific metric design
- **Why Important**: Shows how to design evaluations for custom tasks

#### 4. **"Data Science from Scratch" (2nd Edition)** - Chapter 7 📚
- **URL**: oreilly.com/library/view/data-science-from/9781492041122/ch07.html
- **Time**: 1 hour
- **Topics**: Hypothesis and Inference
- **What You'll Get**: Python code for:
  - t-tests
  - p-values
  - Confidence intervals
  - A/B test implementations
- **Action**: Copy code examples and run on sample data

#### 5. **"Design and Analysis of Experiments" (9th Ed)** by Montgomery 📚
- **URL**: oreilly.com/library/view/design-and-analysis/9781119320937/
- **Time**: 3 hours (Chapter 5 only)
- **Focus On**: Chapter 5 - Factorial Designs
- **Why Critical**: You have 3 factors (context × temperature × repeat penalty)
- **What You'll Learn**:
  - Main effects vs interaction effects
  - 2^k factorial design
  - ANOVA for multi-factor experiments
  - Understanding which parameters matter most

### 📊 Supporting Statistical Resources

#### 6. **"Statistics in a Nutshell" (2nd Edition)** 📚
- **URL**: oreilly.com/library/view/statistics-in-a/9781449361129/
- **Time**: 30 min (reference sections as needed)
- **Use For**: Looking up t-tests, ANOVA, confidence intervals
- **Key Section**: Multiple comparisons - Bonferroni correction, False Discovery Rate

#### 7. **"LLMOps"** - Chapter 7: Evaluation for LLMs 📚
- **URL**: oreilly.com/library/view/llmops/9781098154196/ch07.html
- **Time**: 1 hour
- **Focus**: Production eval infrastructure
- **When to Read**: If you want to automate evals and track over time

#### 8. **"Statistical Rethinking"** by Richard McElreath 📚
- **URL**: oreilly.com/library/view/statistical-rethinking/9781482253481/
- **Time**: 10+ hours (full course)
- **Level**: Advanced
- **When to Read**: If you want Bayesian approach
- **Benefit**: Say "85% probability config A is better than B" instead of "p < 0.05"

### 📝 Quick Reference Articles (Free on O'Reilly Radar)

#### 9. **"A/B Testing: a checklist"**
- **URL**: oreilly.com/content/ab-testing-a-checklist/
- **Time**: 10 min
- **Use**: Quick reference when running experiments

#### 10. **"Escaping POC Purgatory: Evaluation-Driven Development for AI Systems"**
- **URL**: oreilly.com/radar/escaping-poc-purgatory-evaluation-driven-development-for-ai-systems/
- **Time**: 15 min
- **Use**: Motivation and big-picture thinking

#### 11. **"What We Learned from a Year of Building with LLMs (Part II)"**
- **URL**: oreilly.com/radar/what-we-learned-from-a-year-of-building-with-llms-part-ii/
- **Time**: 20 min
- **Use**: Practical tips from practitioners

### 🎥 Additional Videos

#### 12. **"3 Ways to Evaluate an LLM"** by Tom Taulli (April 2024)
- **URL**: oreilly.com/library/view/3-ways-to/0642572035181/
- **Time**: Brief overview

#### 13. **"Large Language Models in Production"** (Live Event Recording)
- **URL**: oreilly.com/live-events/large-language-models-in-production/
- **Topics**: Traditional ML eval vs LLM eval, eval datasets, GPT-as-judge

---

## Free Online Resources

### Statistics Fundamentals

#### **Khan Academy: Statistics & Probability**
- **URL**: khanacademy.org/math/statistics-probability
- **Time**: ~20 hours
- **Why**: Interactive, visual, no prerequisites
- **Focus On**: Hypothesis testing, confidence intervals, comparing distributions
- **Cost**: Free

#### **StatQuest with Josh Starmer (YouTube)**
- **Channel**: youtube.com/@statquest
- **Time**: 5-15 min per video
- **Why**: Best explanations of t-tests, p-values, ANOVA
- **Must-Watch Videos**:
  - "Hypothesis Testing and The Null Hypothesis"
  - "P-values: What they are and how to interpret them"
  - "Statistical Power"
  - "Multiple Comparisons (FDR, Bonferroni)"
- **Cost**: Free

### Experimental Design

#### **"Improving Your Statistical Inferences"** (Coursera - Eindhoven)
- **Instructor**: Daniël Lakens
- **URL**: coursera.org/learn/statistical-inferences
- **Time**: ~8 weeks
- **Why**: Perfect for parameter sweeps - covers sample size, effect size, multiple comparisons
- **Topics**: Power analysis, replication, Bayesian thinking
- **Cost**: Free to audit

#### **"A/B Testing by Google"** (Udacity)
- **URL**: udacity.com/course/ab-testing--ud257
- **Time**: ~4 weeks
- **Why**: Directly applicable to parameter sweeps
- **Cost**: Free

### LLM Evaluation

#### **DeepLearning.AI: Building and Evaluating Advanced RAG**
- **URL**: deeplearning.ai/short-courses
- **Time**: ~1 hour
- **Instructor**: Andrew Ng + LlamaIndex team
- **Why**: Shows eval frameworks for LLM applications
- **Cost**: Free

#### **Anthropic's Intro to Prompt Engineering**
- **URL**: github.com/anthropics/courses
- **Time**: ~2-3 hours
- **Focus On**: Creating eval datasets, rubrics, metrics
- **Cost**: Free

#### **Stanford CS25: Transformers United**
- **URL**: web.stanford.edu/class/cs25/
- **Time**: Select lectures (~2 hours)
- **Watch**: Lectures on HELM, BIG-bench
- **Cost**: Free (videos on YouTube)

---

## Academic Papers & Frameworks

### **HELM (Holistic Evaluation of Language Models)**
- **Paper**: arxiv.org/abs/2211.09110
- **Framework**: github.com/stanford-crfm/helm
- **Why**: Shows how to think about multi-dimensional evaluation
- **Topics**: Metrics, scenarios, evaluation methodology

### **BIG-bench (Beyond the Imitation Game)**
- **Paper**: arxiv.org/abs/2206.04615
- **Why**: 200+ diverse tasks, good for understanding task design principles

### **AgentBench**
- **Paper**: arXiv:2308.03688
- **Why**: Benchmark suite for LLM-as-agent tasks
- **Focus**: Methodology section on evaluation design for multi-step agents

---

## Learning Schedule Options

### Weekend Sprint (11 hours)

**Saturday:**
- Morning: Lisa Qian A/B Testing video (2h)
- Afternoon: LLM Engineer's Handbook Ch7 (2h)
- Evening: Data Science from Scratch Ch7 (1h)

**Sunday:**
- Morning: Write analysis script (3h)
- Afternoon: Generate visualizations (2h)
- Evening: Interpret results (1h)

**Outcome**: Understand how to evaluate parameter sweep

### Week-Long Deep Dive (18 hours)

| Day | Content | Hours | Goal |
|-----|---------|-------|------|
| Mon | Lisa Qian A/B Testing video | 2 | Understand experiment design |
| Tue | Data Science from Scratch Ch7 | 2 | Learn Python stats tools |
| Wed | LLM Engineer's Handbook Ch7 | 2 | LLM-specific metrics |
| Thu | Montgomery Ch5 (Factorial Design) | 3 | Multi-factor analysis |
| Fri | "Evaluating LLMs" video | 2 | Real-world examples |
| Sat | Write analysis scripts | 4 | Apply to your data |
| Sun | Visualize + interpret results | 3 | Draw conclusions |

### Month-Long Comprehensive (40+ hours)

**Week 1**: StatQuest videos + Khan Academy hypothesis testing
**Week 2**: "Improving Your Statistical Inferences" (Coursera)
**Week 3**: O'Reilly books (LLM Engineer's Handbook, Montgomery)
**Week 4**: Apply to real data + HELM paper

---

## Applying to Parameter Sweep

### Your Specific Use Case

**Task**: Navigate 60x60 maze to goal
**Experiment**: 12 configs testing 3 factors
- Context window: 2K, 8K, 32K
- Temperature: 0.0, 0.1, 0.2, 0.5, 0.7, 1.0
- Repeat penalty: 1.0, 1.2, 1.4, 1.6

### Evaluation Framework

**Success Metric (Primary)**:
- Reached goal? (binary outcome)

**Efficiency Metrics (Secondary)**:
- Steps to completion
- Wall hit rate
- Unique tiles explored
- Exploration efficiency

**Diagnostic Metrics**:
- Token usage
- Repeated positions (stuck behavior)
- Directional diversity

### Statistical Approach

1. **Multiple Comparisons Correction**
   - Testing 12 configs → Bonferroni: p < 0.05/12 = 0.00417
   - Prevents false discoveries

2. **Factorial Design Analysis**
   - Use ANOVA to understand main effects and interactions
   - Example: "Does temperature matter? Only when context is large?"

3. **Replication Strategy**
   - Better: 3-4 promising configs × 5 runs each
   - Worse: 12 configs × 1 run each
   - Separates signal from noise

4. **Visualization**
   - Box plots of steps-to-completion (shows distribution)
   - Survival curves (% still running at step N)
   - Exploration heatmaps (which tiles visited)

### Python Tools

```python
# Statistical analysis
import scipy.stats
import pandas as pd

# Visualization
import matplotlib.pyplot as plt
import seaborn as sns

# For advanced stats
import statsmodels.api as sm
from statsmodels.formula.api import ols
```

### SQL Query Template

```sql
-- Extract experiment metrics
SELECT
  e.id,
  e.model_name,
  COUNT(a.id) as total_actions,
  MAX(a.turn_number) as turns,
  COUNT(*) FILTER (WHERE a.success AND a.action_type LIKE 'move_%') as successful_moves,
  COUNT(*) FILTER (WHERE NOT a.success AND a.action_type LIKE 'move_%') as wall_hits,
  COUNT(DISTINCT (a.to_x, a.to_y)) as unique_positions
FROM experiments e
JOIN agent_actions a ON e.id = a.experiment_id
GROUP BY e.id, e.model_name
ORDER BY e.id;
```

---

## Key Concepts to Understand

### Multiple Comparisons Problem
When testing 12 configs, random chance gives you ~46% probability of at least one "significant" result even if nothing matters. Use Bonferroni correction or False Discovery Rate.

### Effect Size vs Statistical Significance
A result can be statistically significant but practically meaningless (or vice versa). Always report both p-values AND effect sizes (Cohen's d).

### Main Effects vs Interactions
- **Main effect**: "Higher temperature always improves performance"
- **Interaction**: "Higher temperature helps ONLY when context is large"
Factorial designs reveal interactions that sequential testing misses.

### Sample Size & Power
Before running experiments, calculate: "How many runs do I need to detect a meaningful difference?" Use power analysis (covered in "Improving Your Statistical Inferences").

---

## Communities for Questions

- **r/statistics** (Reddit) - Ask questions, get feedback
- **Cross Validated** (stats.stackexchange.com) - Q&A for statistics
- **EleutherAI Discord** - LLM evaluation discussions
- **Anthropic Discord** - Eval best practices (with API access)

---

## Books That Changed Perspectives

1. **"The Design of Experiments"** by R.A. Fisher (classic, dense but foundational)
2. **"Trustworthy Online Controlled Experiments"** by Kohavi et al. (A/B testing bible)
3. **"Improving Your Statistical Inferences"** by Lakens (free course)
4. **"Naked Statistics"** by Charles Wheelan (accessible introduction)

---

## Common Mistakes to Avoid

1. **Optimizing for noise**: Running 12 configs once each and picking the "winner" (could be random)
2. **Ignoring multiple comparisons**: Using p < 0.05 without correction when testing many hypotheses
3. **Focusing only on means**: Look at distributions, not just averages
4. **No replication**: Need 3-5 runs per config to separate signal from noise
5. **Cherry-picking metrics**: Decide on success criteria BEFORE running experiments

---

## Next Steps After Learning

1. Write SQL queries to extract experiment metrics
2. Write Python analysis script with proper statistical tests
3. Create visualizations (box plots, survival curves, heatmaps)
4. Interpret results - what do the numbers mean?
5. Plan follow-up experiments based on findings
6. Document methodology for reproducibility

---

## Cost Summary

- **O'Reilly Learning Platform**: ~$49/month or $499/year (already subscribed ✓)
- **Khan Academy**: Free
- **StatQuest**: Free
- **Coursera**: Free to audit (paid certificates optional)
- **DeepLearning.AI**: Free
- **Academic Papers**: Free

**Total additional cost**: $0 (if using free resources) to $49/month (if adding Coursera certificates)
