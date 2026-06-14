// LeetCode Contest Cheater Detector Content Script

(function () {
  console.log("LeetCode Contest Cheater Detector loading...");

  // Prevent duplicate insertion
  if (window.lcCheaterDetectorLoaded) {
    console.log("LeetCode Contest Cheater Detector already loaded. Re-initializing UI...");
    // Remove old elements if they exist to avoid duplicates
    document.getElementById('lc-cheater-panel')?.remove();
    document.getElementById('lc-cheater-activator')?.remove();
    document.getElementById('lc-cheater-toast')?.remove();
  }
  window.lcCheaterDetectorLoaded = true;

  // Configuration State (Persisted in localStorage)
  const CONFIG_KEY = 'lc_cheater_detector_config';
  const DEFAULT_CONFIG = {
    q1Threshold: 20,          // seconds for Q1/first solve from start
    consecutiveThreshold: 60,  // seconds between consecutive solves (Q2/Q3)
    q4Threshold: 90,          // seconds specifically for Q4 gap
    startPage: 1,
    endPage: 5,
    rateLimitDelay: 350       // ms between API fetches
  };

  let config = { ...DEFAULT_CONFIG };
  let scanInProgress = false;
  let abortController = null;
  let flaggedUsers = []; // Stores user objects: { username, rank, score, anomalies }
  let isModifyingDOM = false; // Guard to prevent MutationObserver infinite loops

  // Load config from localStorage
  const loadConfig = () => {
    try {
      const stored = localStorage.getItem(CONFIG_KEY);
      if (stored) {
        config = { ...config, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.error('Failed to load LC Cheater Detector config', e);
    }
  };

  // Save config to localStorage
  const saveConfig = () => {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (e) {
      console.error('Failed to save LC Cheater Detector config', e);
    }
  };

  loadConfig();

  // Helper: Normalize Unix timestamps to seconds (handles ms timestamps)
  const normalizeToSeconds = (timestamp) => {
    if (!timestamp) return 0;
    const num = Number(timestamp);
    if (isNaN(num)) return 0;
    // 13-digit Unix timestamps are in milliseconds
    if (num > 99999999999) {
      return Math.floor(num / 1000);
    }
    return num;
  };

  // Helper: Extract submission date/time from common possible property names
  const getSubmissionDate = (sub) => {
    if (!sub) return null;
    // Check all common keys LeetCode might return
    const rawVal = sub.date ?? sub.time ?? sub.timestamp ?? sub.finish_time;
    return rawVal ? normalizeToSeconds(rawVal) : null;
  };

  // Helper: Format duration (seconds -> HH:MM:SS)
  const formatDuration = (totalSeconds) => {
    if (totalSeconds < 0) totalSeconds = 0;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return [
      h.toString().padStart(2, '0'),
      m.toString().padStart(2, '0'),
      s.toString().padStart(2, '0')
    ].join(':');
  };

  // Helper: Extract contest slug from current URL
  const getContestSlug = () => {
    const match = window.location.pathname.match(/\/contest\/([^\/]+)\/ranking/);
    return match ? match[1] : null;
  };

  // Helper: Fetch Contest Start Time from GraphQL
  const fetchContestInfo = async (contestSlug) => {
    console.log(`Fetching contest details for slug: ${contestSlug}`);
    const query = `
      query contestInfo($titleSlug: String!) {
        contest(titleSlug: $titleSlug) {
          startTime
          title
          duration
        }
      }
    `;
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { titleSlug: contestSlug } })
    });
    if (!response.ok) {
      throw new Error(`GraphQL query failed with status: ${response.status}`);
    }
    const result = await response.json();
    if (result.errors) {
      throw new Error(result.errors[0].message);
    }
    if (!result.data || !result.data.contest) {
      throw new Error("Contest details not found in GraphQL response.");
    }
    return result.data.contest;
  };

  // Helper: Fetch ranking data page-by-page
  const fetchRankingPage = async (contestSlug, page, signal) => {
    const url = `https://leetcode.com/contest/api/ranking/${contestSlug}/?pagination=${page}&region=global`;
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`API fetch failed on page ${page} with status: ${response.status}`);
    }
    return response.json();
  };

  // UI Injection: Create the Floating Button and slide-out panel
  const injectUI = () => {
    console.log("Injecting Cheater Detector DOM elements...");

    // 1. Toast Notification
    const toast = document.createElement('div');
    toast.className = 'lc-toast';
    toast.id = 'lc-cheater-toast';
    toast.innerHTML = `
      <svg class="lc-toast-icon" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
      </svg>
      <span id="lc-cheater-toast-msg">Report copied to clipboard!</span>
    `;
    document.body.appendChild(toast);

    // 2. Sidebar Panel
    const panel = document.createElement('div');
    panel.className = 'lc-cheater-panel';
    panel.id = 'lc-cheater-panel';

    panel.innerHTML = `
      <div class="lc-cheater-header">
        <h2 class="lc-cheater-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="22" height="22">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Contest Cheater Detector
        </h2>
        <button class="lc-cheater-close-btn" id="lc-cheater-close-btn" title="Close Panel">✕</button>
      </div>

      <div class="lc-cheater-body">
        <!-- Contest Info InfoCard -->
        <div class="lc-cheater-card" style="border-left: 4px solid #8b5cf6;">
          <div class="lc-cheater-section-title">Contest Context</div>
          <div id="lc-contest-details" style="font-size: 13px; line-height: 1.5; color: #e5e7eb;">
            Loading contest details...
          </div>
        </div>

        <!-- Configuration Form -->
        <div class="lc-cheater-card">
          <div class="lc-cheater-section-title">Detection Thresholds</div>
          
          <div class="lc-cheater-row">
            <div class="lc-cheater-input-group">
              <label for="lc-input-q1" title="Flag if a user solves any problem in under this time from contest start">
                First Solve (s)
              </label>
              <input type="number" id="lc-input-q1" class="lc-cheater-input" min="1" value="${config.q1Threshold}">
            </div>
            
            <div class="lc-cheater-input-group">
              <label for="lc-input-consec" title="Flag if the time gap between Q1->Q2 or Q2->Q3 is under this time">
                Q2/Q3 Gap (s)
              </label>
              <input type="number" id="lc-input-consec" class="lc-cheater-input" min="1" value="${config.consecutiveThreshold}">
            </div>

            <div class="lc-cheater-input-group">
              <label for="lc-input-q4" title="Flag if the time gap to Q4 is under this time">
                Q4 Gap (s)
              </label>
              <input type="number" id="lc-input-q4" class="lc-cheater-input" min="1" value="${config.q4Threshold}">
            </div>
          </div>

          <div class="lc-cheater-row" style="margin-top: 4px;">
            <div class="lc-cheater-input-group">
              <label for="lc-input-start-page">Start Page</label>
              <input type="number" id="lc-input-start-page" class="lc-cheater-input" min="1" value="${config.startPage}">
            </div>
            <div class="lc-cheater-input-group">
              <label for="lc-input-end-page">End Page</label>
              <input type="number" id="lc-input-end-page" class="lc-cheater-input" min="1" value="${config.endPage}">
            </div>
          </div>
        </div>

        <!-- Scan Actions -->
        <div class="lc-cheater-buttons">
          <button class="lc-btn lc-btn-primary" id="lc-scan-start-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            Scan Leaderboard
          </button>
          <button class="lc-btn lc-btn-secondary" id="lc-scan-stop-btn" disabled>Stop</button>
        </div>

        <!-- Progress Indicator -->
        <div class="lc-cheater-progress-container" id="lc-progress-container">
          <div class="lc-cheater-progress-info">
            <span id="lc-progress-status">Idle</span>
            <span id="lc-progress-percent">0%</span>
          </div>
          <div class="lc-cheater-progress-bar-bg">
            <div class="lc-cheater-progress-bar" id="lc-progress-bar"></div>
          </div>
        </div>

        <!-- Results Dashboard -->
        <div>
          <div class="lc-cheater-results-header">
            <div class="lc-cheater-section-title" style="margin: 0;">Anomalies Detected</div>
            <span class="lc-cheater-results-count" id="lc-cheater-count">0 Flagged</span>
          </div>
          <div class="lc-cheater-results-list" id="lc-results-list" style="margin-top: 12px;">
            <div class="lc-cheater-empty" id="lc-empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
              </svg>
              <span>No active scan. Configure settings and click Scan above to check rankings.</span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // 3. Floating Activator Button
    const activator = document.createElement('button');
    activator.className = 'lc-cheater-activator';
    activator.id = 'lc-cheater-activator';
    activator.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
      </svg>
      <span>LC Cheaters</span>
    `;
    document.body.appendChild(activator);
    console.log("DOM elements successfully appended to page body.");
  };

  try {
    injectUI();
  } catch (e) {
    console.error("Failed to inject Cheater Detector UI:", e);
  }

  // DOM Handles
  const elPanel = document.getElementById('lc-cheater-panel');
  const elActivator = document.getElementById('lc-cheater-activator');
  const elCloseBtn = document.getElementById('lc-cheater-close-btn');
  const elContestDetails = document.getElementById('lc-contest-details');
  const elStartBtn = document.getElementById('lc-scan-start-btn');
  const elStopBtn = document.getElementById('lc-scan-stop-btn');
  const elProgressBar = document.getElementById('lc-progress-bar');
  const elProgressPercent = document.getElementById('lc-progress-percent');
  const elProgressStatus = document.getElementById('lc-progress-status');
  const elProgressContainer = document.getElementById('lc-progress-container');
  const elResultsList = document.getElementById('lc-results-list');
  const elResultsCount = document.getElementById('lc-cheater-count');
  const elEmptyState = document.getElementById('lc-empty-state');

  // Input fields
  const elInputQ1 = document.getElementById('lc-input-q1');
  const elInputConsec = document.getElementById('lc-input-consec');
  const elInputQ4 = document.getElementById('lc-input-q4');
  const elInputStartPage = document.getElementById('lc-input-start-page');
  const elInputEndPage = document.getElementById('lc-input-end-page');

  // Load configuration UI values
  const syncConfigUI = () => {
    if (elInputQ1) elInputQ1.value = config.q1Threshold;
    if (elInputConsec) elInputConsec.value = config.consecutiveThreshold;
    if (elInputQ4) elInputQ4.value = config.q4Threshold;
    if (elInputStartPage) elInputStartPage.value = config.startPage;
    if (elInputEndPage) elInputEndPage.value = config.endPage;
  };

  // Get current config values from UI inputs
  const readConfigUI = () => {
    config.q1Threshold = parseInt(elInputQ1.value, 10) || DEFAULT_CONFIG.q1Threshold;
    config.consecutiveThreshold = parseInt(elInputConsec.value, 10) || DEFAULT_CONFIG.consecutiveThreshold;
    config.q4Threshold = parseInt(elInputQ4.value, 10) || DEFAULT_CONFIG.q4Threshold;
    config.startPage = Math.max(1, parseInt(elInputStartPage.value, 10) || DEFAULT_CONFIG.startPage);
    config.endPage = Math.max(config.startPage, parseInt(elInputEndPage.value, 10) || DEFAULT_CONFIG.endPage);
    saveConfig();
  };

  // Toggle Panel open/close
  const togglePanel = () => {
    console.log("LC Activator Button clicked! Toggling panel visibility...");
    if (!elPanel) {
      console.error("lc-cheater-panel not found in page!");
      return;
    }
    elPanel.classList.toggle('open');
    if (elPanel.classList.contains('open')) {
      console.log("Panel opened. Querying contest details and highlighting current page...");
      updateContestHeader();
      applyInPageHighlights();
    } else {
      console.log("Panel closed.");
    }
  };

  if (elActivator) elActivator.addEventListener('click', togglePanel);
  if (elCloseBtn) elCloseBtn.addEventListener('click', togglePanel);

  // Update Contest Header Details
  let cachedContestSlug = null;
  let cachedContestInfo = null;

  const updateContestHeader = async () => {
    const contestSlug = getContestSlug();
    if (!contestSlug) {
      if (elContestDetails) {
        elContestDetails.innerHTML = `<span style="color: #f43f5e; font-weight: 500;">Anomaly: Not on a contest ranking page.</span><br/>Navigate to <code>leetcode.com/contest/*/ranking</code> to fetch data.`;
      }
      if (elStartBtn) elStartBtn.disabled = true;
      return;
    }

    if (elStartBtn) elStartBtn.disabled = false;
    if (contestSlug === cachedContestSlug && cachedContestInfo) {
      displayContestInfoCard(cachedContestInfo);
      return;
    }

    if (elContestDetails) {
      elContestDetails.innerHTML = `<div class="lc-cheater-empty" style="padding: 10px;">Loading contest data...</div>`;
    }

    try {
      const contest = await fetchContestInfo(contestSlug);
      cachedContestSlug = contestSlug;
      cachedContestInfo = contest;
      displayContestInfoCard(contest);
    } catch (e) {
      console.error("Error in updateContestHeader:", e);
      if (elContestDetails) {
        elContestDetails.innerHTML = `<span style="color: #ef4444;">Error fetching contest start time:</span><br/>${e.message}<br/><br/>Please make sure you are logged in to LeetCode and refresh the page.`;
      }
    }
  };

  const displayContestInfoCard = (contest) => {
    if (!elContestDetails) return;
    const startStr = new Date(contest.startTime * 1000).toLocaleString();
    const durationMins = Math.round(contest.duration / 60);
    elContestDetails.innerHTML = `
      <strong>${contest.title}</strong><br/>
      <span style="font-size:12px; color: #9ca3af;">
        Start: ${startStr}<br/>
        Duration: ${durationMins} minutes
      </span>
    `;
  };

  // Show Toast
  const showToast = (message) => {
    const toast = document.getElementById('lc-cheater-toast');
    const toastMsg = document.getElementById('lc-cheater-toast-msg');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  };

  // Copy report to clipboard helper
  const copyReportToClipboard = (username, anomalies, btnElement) => {
    const text = generateReportText(username, anomalies);
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied report for ${username} to clipboard!`);
      if (btnElement) {
        btnElement.classList.add('copied');
        const origHtml = btnElement.innerHTML;
        btnElement.innerHTML = `✓ Copied!`;
        setTimeout(() => {
          btnElement.classList.remove('copied');
          btnElement.innerHTML = origHtml;
        }, 2000);
      }
    }).catch(err => {
      console.error('Clipboard copy failed', err);
      alert('Failed to copy report to clipboard. Copy from developer console.');
      console.log(`=== REPORT TEMPLATE FOR USER: ${username} ===\n\n${text}\n======================================`);
    });
  };

  // Helper: Parse current page number from LeetCode URL pathname
  const getCurrentPageNumber = () => {
    const match = window.location.pathname.match(/\/contest\/[^\/]+\/ranking\/(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
  };

  // Scroll to and highlight a user row in LeetCode's ranking table
  const highlightUserRow = (username, userPage) => {
    if (userPage) {
      const curPage = getCurrentPageNumber();
      if (curPage !== userPage) {
        const contestSlug = getContestSlug();
        const pageUrl = `https://leetcode.com/contest/${contestSlug}/ranking/${userPage}/`;
        showToast(`Navigating to Page ${userPage}...`);
        sessionStorage.setItem('lc_highlight_user', username);
        window.location.href = pageUrl;
        return;
      }
    }

    const row = findRowForUser(username);
    if (row) {
      isModifyingDOM = true;
      try {
        row.classList.add('lc-flagged-row');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        row.style.outline = '3px solid #f43f5e';
        row.style.boxShadow = '0 0 15px rgba(244, 63, 94, 0.4)';
        setTimeout(() => {
          row.style.outline = '';
          row.style.boxShadow = '';
        }, 3000);
      } finally {
        isModifyingDOM = false;
      }
    } else {
      showToast(`User "${username}" row not found on current page.`);
    }
  };

  // Generate support ticket body text for a single anomaly
  const generateReportTextSingle = (username, anomaly) => {
    let evidence = "";
    if (anomaly.type === 'first_solve') {
      evidence = `They submitted Q${anomaly.currNum} at ${anomaly.currTime} (just ${anomaly.seconds} seconds after the contest started). It is highly improbable to read the prompt, write the logic, and pass all test cases from scratch in ${anomaly.seconds} seconds.`;
    } else {
      evidence = `They submitted Q${anomaly.prevNum} at ${anomaly.prevTime} and then submitted Q${anomaly.currNum} just ${anomaly.seconds} seconds later at ${anomaly.currTime}. It is highly improbable to transition to a new problem, read the prompt, write the logic, and pass all test cases from scratch in ${anomaly.seconds} seconds.`;
    }

    return `Hello LeetCode Support,

Please review the submissions for user ${username}. ${evidence}

This strongly indicates the user is copy-pasting pre-written code from an external leaked source. I have spent hours cleaning the leaderboard to help maintain a fair environment, and I would appreciate it if you could run a code similarity check on their submissions.`;
  };

  // Generate individual HTML card for flagged user
  const renderFlaggedUserCard = (user) => {
    const card = document.createElement('div');
    card.className = 'lc-cheater-user-card';
    const contestSlug = getContestSlug();
    const pageUrl = `https://leetcode.com/contest/${contestSlug}/ranking/${user.page}/`;

    const anomalyHtml = user.anomalies.map((a, index) => {
      if (a.type === 'first_solve') {
        return `
          <div class="lc-cheater-anomaly-item" style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <span><strong>Fast Solve:</strong> Q${a.currNum} in ${a.seconds}s (${a.currTime})</span>
            <button class="lc-card-btn lc-card-btn-report sub-report-btn" data-index="${index}" style="margin: 0; padding: 4px 8px; font-size: 10px; flex-shrink: 0;">
              Copy
            </button>
          </div>
        `;
      } else {
        return `
          <div class="lc-cheater-anomaly-item" style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <span><strong>Sub 60s Gap:</strong> Q${a.prevNum} (${a.prevTime}) → Q${a.currNum} (${a.currTime}) [${a.seconds}s]</span>
            <button class="lc-card-btn lc-card-btn-report sub-report-btn" data-index="${index}" style="margin: 0; padding: 4px 8px; font-size: 10px; flex-shrink: 0;">
              Copy
            </button>
          </div>
        `;
      }
    }).join('');

    card.innerHTML = `
      <div class="lc-cheater-user-info">
        <div class="lc-cheater-user-identity">
          <div class="lc-cheater-username-row">
            <span class="lc-cheater-user-rank">Rank ${user.rank}</span>
            <a href="${pageUrl}" target="_blank" class="lc-cheater-page-link" title="Open ranking page ${user.page} in new tab">Page ${user.page}</a>
            <a href="https://leetcode.com/${user.username}/" target="_blank" class="lc-cheater-username">${user.username}</a>
          </div>
          <div class="lc-cheater-user-score">Score: ${user.score} pts</div>
        </div>
      </div>
      <div class="lc-cheater-anomalies">
        ${anomalyHtml}
      </div>
      <div class="lc-cheater-card-actions">
        <button class="lc-btn lc-btn-secondary btn-highlight-action" style="width: 100%; padding: 6px 12px; font-size: 11px;">
          <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" style="display:inline; vertical-align:middle; margin-right:2px;">
            <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd"/>
          </svg>
          Highlight User Row
        </button>
      </div>
    `;

    // Attach listeners to individual copy buttons
    card.querySelectorAll('.sub-report-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        const anomaly = user.anomalies[idx];
        const text = generateReportTextSingle(user.username, anomaly);
        navigator.clipboard.writeText(text).then(() => {
          showToast(`Copied report for Q${anomaly.currNum || anomaly.prevNum} to clipboard!`);
          const origText = e.currentTarget.textContent.trim();
          e.currentTarget.textContent = "✓";
          e.currentTarget.style.backgroundColor = "rgba(16, 185, 129, 0.2)";
          e.currentTarget.style.color = "#34d399";
          setTimeout(() => {
            e.currentTarget.textContent = origText;
            e.currentTarget.style.backgroundColor = "";
            e.currentTarget.style.color = "";
          }, 1500);
        });
      });
    });

    card.querySelector('.btn-highlight-action').addEventListener('click', () => {
      highlightUserRow(user.username, user.page);
    });

    return card;
  };

  // Start checking contest ranks
  const startScan = async () => {
    readConfigUI();
    const contestSlug = getContestSlug();
    if (!contestSlug) {
      showToast("Cannot start scan: Invalid page URL.");
      return;
    }

    // Initialize/Reset State
    scanInProgress = true;
    abortController = new AbortController();
    flaggedUsers = [];
    
    // UI state
    elStartBtn.disabled = true;
    elStopBtn.disabled = false;
    elProgressContainer.style.display = 'flex';
    elEmptyState.style.display = 'none';
    elResultsList.innerHTML = '';
    elResultsCount.textContent = '0 Flagged';
    
    // Set custom threshold filters
    const q1Threshold = config.q1Threshold;
    const consecutiveThreshold = config.consecutiveThreshold;
    const q4Threshold = config.q4Threshold;

    elProgressStatus.textContent = "Loading contest details...";
    elProgressPercent.textContent = "0%";
    elProgressBar.style.width = "0%";

    try {
      // Fetch details
      const contest = await fetchContestInfo(contestSlug);
      const contestStartTime = normalizeToSeconds(contest.startTime);
      cachedContestInfo = contest;
      displayContestInfoCard(contest);

      console.log("=== SCAN DIAGNOSTIC DETAILS ===");
      console.log(`Scan started. Q1 Threshold: ${q1Threshold}s, Q2/Q3 Threshold: ${consecutiveThreshold}s, Q4 Threshold: ${q4Threshold}s`);
      console.log(`Contest: ${contest.title} | StartTime (unix): ${contestStartTime}`);

      const totalPages = config.endPage - config.startPage + 1;
      let processedPages = 0;

      for (let page = config.startPage; page <= config.endPage; page++) {
        if (!scanInProgress) break;

        elProgressStatus.textContent = `Scanning ranking page ${page}...`;
        const percentage = Math.round((processedPages / totalPages) * 100);
        elProgressPercent.textContent = `${percentage}%`;
        elProgressBar.style.width = `${percentage}%`;

        const data = await fetchRankingPage(contestSlug, page, abortController.signal);
        
        if (data.total_rank && data.submissions) {
          // Map of contest question id & global question id -> relative order index (1..4)
          const questionIdToNum = {};
          if (data.questions) {
            data.questions.forEach((q, idx) => {
              questionIdToNum[q.id] = idx + 1;
              questionIdToNum[q.question_id] = idx + 1;
            });
          }

          // Diagnostic log for page 1
          if (processedPages === 0 && data.total_rank.length > 0) {
            console.log("Page 1 first participant:", data.total_rank[0]);
            console.log("Page 1 first submissions list:", data.submissions[0]);
            console.log("Question ID mapping built:", questionIdToNum);
          }

          // Scan contestants
          for (let k = 0; k < data.total_rank.length; k++) {
            const contestant = data.total_rank[k];
            const submissionsMap = data.submissions[k];
            const username = contestant.username;

            // Extract accepted submissions chronologically
            const solved = [];
            for (const qId in submissionsMap) {
              const sub = submissionsMap[qId];
              const subDate = getSubmissionDate(sub);
              if (sub && subDate !== null) {
                const qNum = questionIdToNum[qId];
                if (qNum) {
                  solved.push({
                    qId,
                    qNum,
                    date: subDate,
                    failCount: sub.fail_count || 0
                  });
                }
              }
            }

            // Sort chronologically
            solved.sort((a, b) => a.date - b.date);

            // Detect anomalies
            const anomalies = [];
            if (solved.length > 0) {
              // Anomaly A: First solve time from start is suspicious
              const firstSub = solved[0];
              const timeFromStart = firstSub.date - contestStartTime;
              if (timeFromStart >= 0 && timeFromStart < q1Threshold) {
                anomalies.push({
                  type: 'first_solve',
                  currNum: firstSub.qNum,
                  seconds: timeFromStart,
                  currTime: formatDuration(timeFromStart),
                  date: firstSub.date
                });
              }

              // Anomaly B: Consecutive solve gap is suspicious
              for (let j = 1; j < solved.length; j++) {
                const prevSub = solved[j - 1];
                const currSub = solved[j];
                const diff = currSub.date - prevSub.date;
                
                // Select threshold based on question number (Q4 gets a dedicated check)
                const threshold = (currSub.qNum === 4) ? q4Threshold : consecutiveThreshold;
                
                if (diff >= 0 && diff < threshold) {
                  const prevTimeFromStart = prevSub.date - contestStartTime;
                  const currTimeFromStart = currSub.date - contestStartTime;
                  anomalies.push({
                    type: 'consecutive_solve',
                    prevNum: prevSub.qNum,
                    currNum: currSub.qNum,
                    seconds: diff,
                    prevTime: formatDuration(prevTimeFromStart),
                    currTime: formatDuration(currTimeFromStart),
                    date: currSub.date
                  });
                }
              }
            }

            if (anomalies.length > 0) {
              const flaggedUser = {
                username,
                rank: contestant.rank,
                score: contestant.score,
                page: page,
                anomalies
              };
              flaggedUsers.push(flaggedUser);
              
              // Append to DOM immediately
              const card = renderFlaggedUserCard(flaggedUser);
              elResultsList.appendChild(card);
              elResultsCount.textContent = `${flaggedUsers.length} Flagged`;
            }
          }
        }

        processedPages++;
        // Apply highlights for the current page
        applyInPageHighlights();

        // Rate limit delay to avoid blocking
        if (page < config.endPage && scanInProgress) {
          await new Promise((resolve) => setTimeout(resolve, config.rateLimitDelay));
        }
      }

      // Finish scan successfully
      scanInProgress = false;
      elProgressStatus.textContent = `Scan completed! Found ${flaggedUsers.length} suspicious accounts.`;
      elProgressPercent.textContent = "100%";
      elProgressBar.style.width = "100%";
      elStartBtn.disabled = false;
      elStopBtn.disabled = true;

      if (flaggedUsers.length === 0) {
        elResultsList.innerHTML = `
          <div class="lc-cheater-empty" style="color: #10b981;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="stroke: #10b981;">
              <circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/>
            </svg>
            <span>Scan finished! No anomalies detected within the specified thresholds.</span>
          </div>
        `;
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        elProgressStatus.textContent = "Scan stopped by user.";
      } else {
        console.error("Scan error encountered:", err);
        elProgressStatus.textContent = `Error during scan: ${err.message}`;
      }
      scanInProgress = false;
      elStartBtn.disabled = false;
      elStopBtn.disabled = true;
    }
  };

  const stopScan = () => {
    if (scanInProgress) {
      scanInProgress = false;
      if (abortController) {
        abortController.abort();
      }
      elProgressStatus.textContent = "Stopping scan...";
      elStopBtn.disabled = true;
    }
  };

  elStartBtn.addEventListener('click', startScan);
  elStopBtn.addEventListener('click', stopScan);

  // Helper: Find a table row corresponding to a LeetCode username
  const findRowForUser = (username) => {
    if (!username) return null;
    const links = document.querySelectorAll('a');
    const targetPath = username.toLowerCase();
    
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = link.textContent.trim();
      const lowerText = text.toLowerCase();
      
      // 1. Case-insensitive exact text match
      if (lowerText === targetPath) {
        const tr = link.closest('tr') || link.closest('[role="row"]') || link.closest('.ranking-row') || link.closest('li');
        if (tr) return tr;
      }
      
      // 2. Truncated text matching (e.g. "Archit08..." matches "Archit0853A")
      // Clean visible text of trailing ellipsis
      const cleanText = text.replace(/\.{3,}$/, '').toLowerCase();
      if (cleanText.length >= 3 && targetPath.startsWith(cleanText)) {
        const tr = link.closest('tr') || link.closest('[role="row"]') || link.closest('.ranking-row') || link.closest('li');
        if (tr) return tr;
      }
      
      // 3. Href segment match (URLs are never truncated, e.g. href="/Archit0853A/")
      try {
        const path = href.startsWith('http') ? new URL(href).pathname : href;
        const cleanPath = path.toLowerCase().replace(/^\/|\/$/g, '');
        const parts = cleanPath.split('/');
        
        if (parts.includes(targetPath) || parts[parts.length - 1] === targetPath) {
          const tr = link.closest('tr') || link.closest('[role="row"]') || link.closest('.ranking-row') || link.closest('li');
          if (tr) return tr;
        }
      } catch (e) {
        // Safe fallback in case of malformed URLs
      }
    }
    return null;
  };

  // In-Page DOM Highlights: Add visual indicators to the LeetCode leaderboard table
  const applyInPageHighlights = () => {
    isModifyingDOM = true;
    try {
      // Clear previous highlights
      document.querySelectorAll('.lc-flagged-row').forEach(row => {
        row.classList.remove('lc-flagged-row');
        row.querySelectorAll('.lc-badge, .lc-inpage-report-btn').forEach(el => el.remove());
      });

      if (flaggedUsers.length === 0) return;

      flaggedUsers.forEach(user => {
        const row = findRowForUser(user.username);
        if (row) {
          if (row.classList.contains('lc-flagged-row')) return;
          row.classList.add('lc-flagged-row');

          // Find the cell containing username to insert badges
          const links = row.querySelectorAll('a');
          let usernameLink = null;
          for (const link of links) {
            if (link.textContent.trim() === user.username) {
              usernameLink = link;
              break;
            }
          }

          if (usernameLink) {
            // Warning Badge
            const badge = document.createElement('span');
            badge.className = 'lc-badge';
            badge.textContent = '!';
            badge.title = `${user.anomalies.length} anomaly detected.`;
            usernameLink.parentNode.insertBefore(badge, usernameLink.nextSibling);

            // Direct Report Shortcut Buttons
            if (user.anomalies.length === 1) {
              const reportBtn = document.createElement('button');
              reportBtn.className = 'lc-inpage-report-btn';
              reportBtn.innerHTML = `Report`;
              reportBtn.title = "Copy LeetCode Support report template";
              reportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const text = generateReportTextSingle(user.username, user.anomalies[0]);
                navigator.clipboard.writeText(text).then(() => {
                  showToast(`Copied report for ${user.username}!`);
                });
              });
              badge.parentNode.insertBefore(reportBtn, badge.nextSibling);
            } else {
              // Create a separate Report button for each anomaly
              user.anomalies.forEach((anomaly) => {
                const reportBtn = document.createElement('button');
                reportBtn.className = 'lc-inpage-report-btn';
                const labelNum = anomaly.currNum;
                reportBtn.innerHTML = `Report Q${labelNum}`;
                reportBtn.title = `Copy report for Q${labelNum}`;
                reportBtn.style.marginLeft = "4px";
                reportBtn.addEventListener('click', (e) => {
                  e.stopPropagation();
                  const text = generateReportTextSingle(user.username, anomaly);
                  navigator.clipboard.writeText(text).then(() => {
                    showToast(`Copied Report Q${labelNum} for ${user.username}!`);
                  });
                });
                badge.parentNode.insertBefore(reportBtn, badge.nextSibling);
              });
            }
          }
        }
      });
    } catch (e) {
      console.error("Error highlighting rows in-page:", e);
    } finally {
      isModifyingDOM = false;
    }
  };

  // Watch for LeetCode's client-side pagination shifts to re-apply highlights
  const observeTableChanges = () => {
    const tableBody = document.querySelector('tbody') || document.querySelector('.table') || document.querySelector('.ranking-table') || document.body;
    
    const observer = new MutationObserver(() => {
      if (isModifyingDOM) return;
      if (flaggedUsers.length > 0) {
        applyInPageHighlights();
      }
    });

    observer.observe(tableBody, { childList: true, subtree: true });
    console.log("Registered table mutation observer.");
  };

  // Check if there is a pending user highlighting request from a redirection
  const checkPendingHighlight = () => {
    try {
      const username = sessionStorage.getItem('lc_highlight_user');
      if (username) {
        sessionStorage.removeItem('lc_highlight_user');
        console.log(`Found pending highlight request for user: ${username}`);
        
        let attempts = 0;
        const interval = setInterval(() => {
          const row = findRowForUser(username);
          if (row) {
            clearInterval(interval);
            isModifyingDOM = true;
            try {
              row.classList.add('lc-flagged-row');
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
              
              row.style.outline = '3px solid #f43f5e';
              row.style.boxShadow = '0 0 15px rgba(244, 63, 94, 0.4)';
              setTimeout(() => {
                row.style.outline = '';
                row.style.boxShadow = '';
              }, 3000);
            } finally {
              isModifyingDOM = false;
            }
          }
          attempts++;
          if (attempts > 30) {
            clearInterval(interval);
            console.log(`Failed to highlight user "${username}" after 3 seconds.`);
          }
        }, 100);
      }
    } catch (e) {
      console.error("Error checking pending highlight:", e);
    }
  };

  try {
    observeTableChanges();
  } catch (e) {
    console.error("Failed to register MutationObserver:", e);
  }

  checkPendingHighlight();
  syncConfigUI();
  console.log("LeetCode Contest Cheater Detector loaded successfully!");
})();
