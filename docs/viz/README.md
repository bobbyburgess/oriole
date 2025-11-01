# Oriole Experiment Visualizations

Interactive D3.js visualizations for analyzing Oriole maze navigation experiments.

## Files

- **temperature-analysis.html** - BATCH 1 analysis (qwen2.5:7b-128k, v7-neutral, temps 0.0-1.0)

## How to View

Simply open the HTML files directly in your browser:

```bash
# From this directory
open temperature-analysis.html

# Or from project root
open docs/viz/temperature-analysis.html
```

No server required - all data is embedded in the HTML files.

## Features

Each visualization includes:
- **Interactive tooltips** - Hover over data points for details
- **Success/failure indicators** - Green = goal found, Red = failed
- **Multiple dimensions**:
  - Success rate vs temperature
  - Movement efficiency (moves per turn)
  - Exploration patterns (direction changes, reversals)
  - Memory usage (recalls per turn)
  - Position diversity (unique positions explored)
  - Inference performance (tokens/sec)
  - Movement direction distribution (N/S/E/W)

## Technology

- D3.js v7 (loaded from CDN)
- Self-contained HTML (no build step)
- Dark theme optimized for code editors
- Responsive grid layout

## Future Additions

- BATCH 2 analysis (v8-minimal prompt)
- Side-by-side BATCH 1 vs BATCH 2 comparison
- Animated path playback
- Heatmap of maze position visits
