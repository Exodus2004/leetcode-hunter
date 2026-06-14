# LeetCode Contest Cheater Detector (Chrome Extension)

A premium Chrome Extension designed to help maintain a fair environment on LeetCode by scanning contest leaderboards for anomalous submission patterns. It detects fast first solves (e.g. Q1 in under 20s) and rapid consecutive submissions (e.g. Q4 in under 60s from Q3), highlights suspected cheater rows directly in the LeetCode leaderboard table, and generates professionally formatted support reports that can be copied to the clipboard.

## Features

- **Dynamic Anomaly Detection:**
  - **First Solve Threshold:** Configures a limit for the time elapsed from the contest start to a user's first accepted submission (default: 20 seconds).
  - **Consecutive Solve Threshold:** Configures a limit for the gap between any two consecutive accepted submissions (default: 60 seconds).
- **Page-by-Page Crawler:** Scrapes pages of rankings using the browser's credentials, bypassing Cloudflare anti-bot blocks.
- **Glassmorphism Side-out UI:** Slides out a sleek, modern dark panel on the right side of the screen.
- **Visual Leaderboard Highlights:** Highlights suspicious users directly in the LeetCode ranking table with a red warning badge and a direct "Report" shortcut.
- **Dynamic Report Generator:** Generates a detailed report with timestamps, exact elapsed times, and question numbers, customized for multiple anomalies.

## File Structure

```
leetcode-hunter/
├── manifest.json   # Extension manifest file (Manifest V3)
├── content.js      # Core logic, API crawler, and DOM controller
├── content.css     # Premium styling for panel, toast, and highlights
└── README.md       # Project documentation
```

## Installation Instructions

To load this extension into your browser (Chrome, Edge, Brave, etc.):

1. Open your browser and navigate to the extensions management page:
   - **Chrome:** `chrome://extensions/`
   - **Edge:** `edge://extensions/`
   - **Brave:** `brave://extensions/`
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button (usually in the top-left).
4. Select the `leetcode-hunter` folder from your local filesystem (`C:\Users\user\Desktop\ideas\leetcode-hunter`).
5. The extension is now loaded and will automatically run on any LeetCode ranking page!

## How to Use

1. Navigate to any LeetCode contest rankings page (e.g., `https://leetcode.com/contest/weekly-contest-400/ranking/`).
2. Make sure you are logged in to your LeetCode account (required to fetch rankings successfully).
3. Click the floating **LC Cheaters** button on the bottom-right of the screen to open the panel.
4. Set your detection thresholds and specify the page range you want to scan (e.g., Pages 1 to 5).
5. Click **Scan Leaderboard**. The progress bar will indicate the current scanning status.
6. As cheaters are found, they will populate the panel in real-time.
7. You can:
   - Click **Highlight** next to a user to scroll to their row on the LeetCode leaderboard table.
   - Click **Copy Report** to copy the support ticket template to your clipboard.
   - Open a ticket with LeetCode Support and paste the report to report the user.
