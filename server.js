require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
// For deployment: set BASE_URL to your public URL (e.g. https://your-app.railway.app). No trailing slash.
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// Store tokens in memory (in production, use a database)
let accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
let adAccountId = process.env.LINKEDIN_AD_ACCOUNT_ID;

// LinkedIn API headers
const getHeaders = () => ({
  'Authorization': `Bearer ${accessToken}`,
  'X-Restli-Protocol-Version': '2.0.0',
  'LinkedIn-Version': '202504',
  'Content-Type': 'application/json'
});

// Check if authenticated
app.get('/api/auth/status', (req, res) => {
  const hasAdAccount = adAccountId && adAccountId !== 'your_ad_account_id_here';
  res.json({
    authenticated: accessToken && accessToken !== 'your_access_token_here',
    hasAdAccount,
    currentAdAccountId: hasAdAccount ? adAccountId : null
  });
});

// Log out - clear in-memory token and redirect to app (client will show login)
app.get('/auth/logout', (req, res) => {
  accessToken = null;
  adAccountId = null;
  res.redirect('/');
});

// Start OAuth flow - redirect to LinkedIn
app.get('/auth/login', (req, res) => {
  const scopes = 'r_ads,r_ads_reporting,rw_ads';
  const state = Math.random().toString(36).substring(7);

  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${state}`;

  res.redirect(authUrl);
});

// OAuth callback - exchange code for token
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>Authentication Failed</h2>
        <p>${error_description || error}</p>
        <a href="/">Go Back</a>
      </body></html>
    `);
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    accessToken = tokenResponse.data.access_token;

    // Save token to .env file for persistence
    const envPath = path.join(__dirname, '.env');
    const envExamplePath = path.join(__dirname, '.env.example');
    let envContent;
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    } else {
      envContent = fs.existsSync(envExamplePath)
        ? fs.readFileSync(envExamplePath, 'utf8')
        : '';
    }
    envContent = envContent.replace(
      /LINKEDIN_ACCESS_TOKEN=.*/,
      `LINKEDIN_ACCESS_TOKEN=${accessToken}`
    );
    fs.writeFileSync(envPath, envContent);

    console.log('Access token saved!');

    // Redirect to app (main page auto-selects first ad account when none set)
    res.redirect('/');
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>Authentication Failed</h2>
        <p>${error.response?.data?.error_description || error.message}</p>
        <a href="/">Go Back</a>
      </body></html>
    `);
  }
});

// Get ad accounts for the user; ?includeOptimization=1 adds hasOptimization per account.
// Only returns accounts that are selected for optimization (settings), unless no selection saved yet.
app.get('/api/ad-accounts', async (req, res) => {
  try {
    const response = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts?q=search`,
      { headers: getHeaders() }
    );

    let accounts = response.data.elements || [];
    const selectedIds = await readSelectedAccountIds();
    if (selectedIds !== null) {
      const set = new Set(selectedIds.map(id => String(id)));
      accounts = accounts.filter(acc => set.has(String(acc.id)));
    }
    if (req.query.includeOptimization === '1' && accounts.length > 0) {
      const recentFromQuery = req.query.recentlyOptimized
        ? String(req.query.recentlyOptimized).split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const withStatus = await Promise.all(accounts.map(async (acc) => {
        const excludeIds = supabase
          ? (await getRecentlyOptimizedFromDb(acc.id)).map((e) => e.campaignId)
          : recentFromQuery;
        const hasOptimization = await getAccountOptimizationStatus(acc.id, { excludeCampaignIds: excludeIds }).catch(() => false);
        return { ...acc, hasOptimization };
      }));
      accounts = withStatus;
    }
    res.json({ accounts });
  } catch (error) {
    console.error('Error fetching ad accounts:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch ad accounts',
      details: error.response?.data || error.message
    });
  }
});

// Selected accounts for optimization (only these show in account dropdown).
// Uses Supabase if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set; otherwise a local JSON file.
const SELECTED_ACCOUNTS_PATH = path.join(__dirname, 'selected-accounts.json');
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const APP_SETTINGS_ID = 'default';

async function readSelectedAccountIds() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('selected_account_ids')
        .eq('id', APP_SETTINGS_ID)
        .single();
      if (!error && data && data.selected_account_ids != null) return data.selected_account_ids;
      return null;
    } catch (e) {
      console.error('Error reading selected accounts from Supabase:', e.message);
      return null;
    }
  }
  try {
    if (fs.existsSync(SELECTED_ACCOUNTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SELECTED_ACCOUNTS_PATH, 'utf8'));
      return data.selectedIds;
    }
  } catch (e) {
    console.error('Error reading selected accounts:', e.message);
  }
  return null; // null = no filter (show all accounts)
}

async function writeSelectedAccountIds(selectedIds) {
  if (supabase) {
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert(
          { id: APP_SETTINGS_ID, selected_account_ids: selectedIds, updated_at: new Date().toISOString() },
          { onConflict: 'id' }
        );
      if (error) throw error;
      return;
    } catch (e) {
      console.error('Error writing selected accounts to Supabase:', e.message);
      throw e;
    }
  }
  try {
    fs.writeFileSync(SELECTED_ACCOUNTS_PATH, JSON.stringify({ selectedIds }, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing selected accounts:', e.message);
    throw e;
  }
}

// --- Recently optimized (48h window) — stored in Supabase when configured ---
const RECENTLY_OPTIMIZED_MS = 48 * 60 * 60 * 1000;

async function getRecentlyOptimizedFromDb(adAccountId) {
  if (!supabase || !adAccountId) return [];
  const cutoff = new Date(Date.now() - RECENTLY_OPTIMIZED_MS).toISOString();
  const { data, error } = await supabase
    .from('recently_optimized')
    .select('campaign_id, applied_at, previous_bid')
    .eq('ad_account_id', String(adAccountId))
    .gte('applied_at', cutoff)
    .order('applied_at', { ascending: false });
  if (error) {
    console.error('Error reading recently_optimized from Supabase:', error.message);
    return [];
  }
  return (data || []).map((r) => ({
    campaignId: String(r.campaign_id),
    appliedAt: new Date(r.applied_at).getTime(),
    previousBid: r.previous_bid != null ? Number(r.previous_bid) : undefined
  }));
}

async function recordRecentlyOptimizedInDb(adAccountId, campaignId, previousBid) {
  if (!supabase || !adAccountId || !campaignId) return;
  await supabase
    .from('recently_optimized')
    .delete()
    .eq('ad_account_id', String(adAccountId))
    .eq('campaign_id', String(campaignId));
  const { error } = await supabase.from('recently_optimized').insert({
    ad_account_id: String(adAccountId),
    campaign_id: String(campaignId),
    applied_at: new Date().toISOString(),
    previous_bid: previousBid != null ? Number(previousBid) : null
  });
  if (error) console.error('Error recording recently_optimized in Supabase:', error.message);
}

async function removeRecentlyOptimizedFromDb(adAccountId, campaignId) {
  if (!supabase || !adAccountId || !campaignId) return;
  const { error } = await supabase
    .from('recently_optimized')
    .delete()
    .eq('ad_account_id', String(adAccountId))
    .eq('campaign_id', String(campaignId));
  if (error) console.error('Error removing from recently_optimized in Supabase:', error.message);
}

// GET /api/recently-optimized?adAccountId=xxx — list of campaigns in 48h window (for current account)
app.get('/api/recently-optimized', async (req, res) => {
  const adAccountId = req.query.adAccountId;
  if (!adAccountId) {
    return res.status(400).json({ error: 'adAccountId required' });
  }
  const useServer = !!supabase;
  const entries = useServer ? await getRecentlyOptimizedFromDb(adAccountId) : [];
  res.json({ entries, useServer });
});

// GET /api/settings/selected-accounts — which accounts are enabled for optimization
app.get('/api/settings/selected-accounts', async (req, res) => {
  const selectedIds = await readSelectedAccountIds();
  res.json({ selectedIds });
});

// PUT /api/settings/selected-accounts — save which accounts to show in dropdown
app.put('/api/settings/selected-accounts', async (req, res) => {
  const { selectedIds } = req.body;
  if (!Array.isArray(selectedIds)) {
    return res.status(400).json({ error: 'selectedIds must be an array' });
  }
  const normalized = selectedIds.map(id => String(id));
  try {
    await writeSelectedAccountIds(normalized);
    res.json({ selectedIds: normalized });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save settings', details: e.message });
  }
});

// GET /api/settings/accounts — all accounts + selectedIds (for settings page)
app.get('/api/settings/accounts', async (req, res) => {
  try {
    const response = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts?q=search`,
      { headers: getHeaders() }
    );
    const accounts = response.data.elements || [];
    const selectedIds = await readSelectedAccountIds();
    res.json({ accounts, selectedIds });
  } catch (error) {
    console.error('Error fetching ad accounts for settings:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch ad accounts',
      details: error.response?.data || error.message
    });
  }
});

// DELETE /api/account — delete all stored data (settings + 48h window)
app.delete('/api/account', async (req, res) => {
  try {
    if (supabase) {
      const { error: errSettings } = await supabase.from('app_settings').delete().eq('id', APP_SETTINGS_ID);
      if (errSettings) console.error('Error deleting app_settings:', errSettings.message);
      const { error: errRecent } = await supabase.from('recently_optimized').delete().gte('applied_at', '1970-01-01T00:00:00Z');
      if (errRecent) console.error('Error deleting recently_optimized:', errRecent.message);
    }
    if (fs.existsSync(SELECTED_ACCOUNTS_PATH)) {
      fs.unlinkSync(SELECTED_ACCOUNTS_PATH);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting account data:', e.message);
    res.status(500).json({ error: 'Failed to delete account data', details: e.message });
  }
});

// Set the active ad account
app.post('/api/ad-accounts/select', (req, res) => {
  const { accountId } = req.body;

  if (!accountId) {
    return res.status(400).json({ error: 'Account ID required' });
  }

  adAccountId = accountId;

  // Save to .env file
  const envPath = path.join(__dirname, '.env');
  const envExamplePath = path.join(__dirname, '.env.example');
  let envContent;
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  } else {
    envContent = fs.existsSync(envExamplePath)
      ? fs.readFileSync(envExamplePath, 'utf8')
      : '';
  }
  envContent = envContent.replace(
    /LINKEDIN_AD_ACCOUNT_ID=.*/,
    `LINKEDIN_AD_ACCOUNT_ID=${accountId}`
  );
  fs.writeFileSync(envPath, envContent);

  res.json({ success: true });
});

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15000;

// Get campaign id from campaign object (id or $URN).
function getCampaignId(campaign) {
  const raw = campaign.id ?? campaign.$URN ?? campaign;
  if (typeof raw === 'number') return String(raw);
  const s = String(raw);
  return s.startsWith('urn:') ? s.split(':').pop() : s;
}

// Fetch campaignGroupInfo for one campaign: GET .../adCampaigns/{campaignId}?fields=campaignGroupInfo
// Returns group status (e.g. 'ACTIVE') or null on error.
async function getCampaignGroupStatus(accountId, campaignId) {
  try {
    const url = `${LINKEDIN_API_BASE}/adAccounts/${accountId}/adCampaigns/${campaignId}`;
    const response = await axios.get(url, {
      headers: getHeaders(),
      timeout: REQUEST_TIMEOUT_MS,
      params: { fields: 'campaignGroupInfo' }
    });
    const info = response.data?.campaignGroupInfo ?? response.data?.campaigngroupinfo;
    if (!info) return null;
    const status = (info.status ?? info.Status ?? '').toString().toUpperCase();
    return status || null;
  } catch (e) {
    return null;
  }
}

// Filter campaigns to only those whose campaign group status is ACTIVE (per-campaign GET with fields=campaignGroupInfo).
async function filterCampaignsByActiveGroup(accountId, campaigns) {
  if (campaigns.length === 0) return [];
  const BATCH_SIZE = 10;
  const activeIds = new Set();
  for (let i = 0; i < campaigns.length; i += BATCH_SIZE) {
    const batch = campaigns.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (c) => {
        const id = getCampaignId(c);
        const status = await getCampaignGroupStatus(accountId, id);
        return { id, status };
      })
    );
    results.forEach(({ id, status }) => {
      if (status === 'ACTIVE') activeIds.add(id);
    });
  }
  return campaigns.filter(c => activeIds.has(getCampaignId(c)));
}

// Search for Campaigns API: fetch only ACTIVE campaigns, then keep only those in ACTIVE campaign groups.
// For each campaign we GET .../adCampaigns/{campaignId}?fields=campaignGroupInfo and check campaignGroupInfo.status === 'ACTIVE'.
async function fetchAllActiveCampaigns() {
  const opts = { headers: getHeaders(), timeout: REQUEST_TIMEOUT_MS };
  const baseUrl = `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns`;
  const pageSize = 500;
  const maxPages = 50;
  const searchParam = '(status:(values:List(ACTIVE)))';

  try {
    const all = [];
    let pageToken = null;

    for (let page = 0; page < maxPages; page++) {
      const params = {
        q: 'search',
        search: searchParam,
        sortOrder: 'DESCENDING',
        pageSize
      };
      if (pageToken) params.pageToken = pageToken;

      const response = await axios.get(baseUrl, { ...opts, params });
      const elements = response.data.elements || [];
      all.push(...elements);

      const nextToken = response.data.metadata?.nextPageToken;
      if (!nextToken || elements.length === 0) break;
      pageToken = nextToken;
    }

    if (all.length > 0) {
      return await filterCampaignsByActiveGroup(adAccountId, all);
    }
  } catch (e) {
    if (e.response?.status === 400) {
      console.log('Search API returned 400:', e.response?.data?.message || e.message);
    } else {
      throw e;
    }
  }

  // Fallback: one page, no filter
  const response = await axios.get(baseUrl, { ...opts, params: { q: 'search' } });
  const raw = response.data.elements || [];
  const active = raw.filter(c => (c.status || '').toUpperCase() === 'ACTIVE');
  const candidates = active.length > 0 ? active : raw;
  return await filterCampaignsByActiveGroup(adAccountId, candidates);
}

// Fetch active campaigns for a specific account (for optimization status); only in ACTIVE campaign groups.
async function fetchActiveCampaignsForAccount(accountId) {
  const opts = { headers: getHeaders(), timeout: REQUEST_TIMEOUT_MS };
  const baseUrl = `${LINKEDIN_API_BASE}/adAccounts/${accountId}/adCampaigns`;
  const searchParam = '(status:(values:List(ACTIVE)))';
  try {
    const response = await axios.get(baseUrl, {
      ...opts,
      params: { q: 'search', search: searchParam, pageSize: 500 }
    });
    const raw = response.data.elements || [];
    const active = raw.filter(c => (c.status || '').toUpperCase() === 'ACTIVE');
    const candidates = active.length > 0 ? active : raw;
    return await filterCampaignsByActiveGroup(accountId, candidates);
  } catch (e) {
    return [];
  }
}

// Run spend analysis for a given account; returns analysis array (used for optimization flag).
async function runSpendAnalysisForAccount(accountId, bidAdjustmentPercent = 2) {
  const campaigns = await fetchActiveCampaignsForAccount(accountId);
  const getCampaignId = (c) => {
    const raw = c.id ?? c.$URN ?? c;
    if (typeof raw === 'number') return raw;
    const s = String(raw);
    return s.startsWith('urn:') ? s.split(':').pop() : s;
  };
  const campaignsWithId = campaigns.map(c => ({ ...c, _normalizedId: getCampaignId(c) }));
  const today = new Date();
  let analyticsData = {};
  if (campaignsWithId.length > 0) {
    try {
      const BATCH_SIZE = 10;
      const timeoutMs = 10000;
      const DAYS_IN_RANGE = 3;
      const headers = getHeaders();
      const accountUrn = `urn:li:sponsoredAccount:${accountId}`;
      const accountsParam = `List(${encodeURIComponent(accountUrn)})`;
      const endDate = new Date(today);
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (DAYS_IN_RANGE - 1));
      const dateRangeVal = `(start:(year:${startDate.getFullYear()},month:${startDate.getMonth() + 1},day:${startDate.getDate()}),end:(year:${endDate.getFullYear()},month:${endDate.getMonth() + 1},day:${endDate.getDate()}))`;
      for (let i = 0; i < campaignsWithId.length; i += BATCH_SIZE) {
        const batch = campaignsWithId.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (c) => {
          try {
            const id = c._normalizedId;
            const campaignUrn = `urn:li:sponsoredCampaign:${id}`;
            const campaignsParam = `List(${encodeURIComponent(campaignUrn)})`;
            const url = `${LINKEDIN_API_BASE}/adAnalytics?q=analytics&dateRange=${dateRangeVal}&timeGranularity=DAILY&accounts=${accountsParam}&pivot=CAMPAIGN&campaigns=${campaignsParam}&fields=costInLocalCurrency,dateRange`;
            const analyticsResponse = await axios.get(url, { headers, timeout: timeoutMs });
            const elements = analyticsResponse.data.elements || [];
            let totalCost = 0;
            for (const row of elements) {
              if (row && row.costInLocalCurrency != null) totalCost += parseFloat(row.costInLocalCurrency) || 0;
            }
            const avgCost = elements.length ? totalCost / DAYS_IN_RANGE : 0;
            return { id, item: { costInLocalCurrency: String(avgCost) } };
          } catch (e) {
            return { id: c._normalizedId, item: null };
          }
        }));
        results.forEach(({ id, item }) => { if (item) analyticsData[id] = item; });
      }
    } catch (e) {
      // ignore
    }
  }
  const pct = (bidAdjustmentPercent || 2) / 100;
  return campaignsWithId.map(campaign => {
    const id = campaign._normalizedId;
    const dailyBudget = campaign.dailyBudget?.amount ? parseFloat(campaign.dailyBudget.amount) : 0;
    const currentBid = campaign.unitCost?.amount ? parseFloat(campaign.unitCost.amount) : 0;
    const analytics = analyticsData[id] || {};
    const dailySpend = analytics.costInLocalCurrency ? parseFloat(analytics.costInLocalCurrency) : 0;
    const spendPercentage = dailyBudget > 0 ? (dailySpend / dailyBudget) * 100 : 0;
    let recommendation = null;
    if (spendPercentage < 90 && currentBid > 0) recommendation = { action: 'increase' };
    else if (spendPercentage > 100 && currentBid > 0) recommendation = { action: 'decrease' };
    return { id, recommendation };
  });
}

async function getAccountOptimizationStatus(accountId, options = {}) {
  const analysis = await runSpendAnalysisForAccount(accountId).catch(() => []);
  let filtered = analysis;
  const excludeIds = options.excludeCampaignIds;
  if (excludeIds && excludeIds.length > 0) {
    const set = new Set(excludeIds.map(id => String(id)));
    filtered = analysis.filter(c => !set.has(String(c.id)));
  }
  return filtered.some(c => c.recommendation);
}

// General campaign list (one page, no filter) for /api/campaigns
async function fetchAllCampaigns() {
  const url = `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns`;
  const response = await axios.get(url, {
    headers: getHeaders(),
    timeout: REQUEST_TIMEOUT_MS,
    params: { q: 'search' }
  });
  return response.data.elements || [];
}

// Get all campaigns for the ad account
app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await fetchAllCampaigns();
    res.json({ campaigns });
  } catch (error) {
    console.error('Error fetching campaigns:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch campaigns',
      details: error.response?.data || error.message
    });
  }
});

// Get campaign analytics (spend data)
app.get('/api/campaigns/:campaignId/analytics', async (req, res) => {
  try {
    const { campaignId } = req.params;
    if (!adAccountId) {
      return res.status(400).json({ error: 'No ad account selected' });
    }
    const today = new Date();
    const day = today.getDate();
    const month = today.getMonth() + 1;
    const year = today.getFullYear();
    const dateRangeVal = `(start:(year:${year},month:${month},day:${day}),end:(year:${year},month:${month},day:${day}))`;
    const accountUrn = `urn:li:sponsoredAccount:${adAccountId}`;
    const accountsParam = `List(${encodeURIComponent(accountUrn)})`;
    const campaignUrn = `urn:li:sponsoredCampaign:${campaignId}`;
    const campaignsParam = `List(${encodeURIComponent(campaignUrn)})`;
    const url = `${LINKEDIN_API_BASE}/adAnalytics?q=analytics&dateRange=${dateRangeVal}&timeGranularity=DAILY&accounts=${accountsParam}&pivot=CAMPAIGN&campaigns=${campaignsParam}&fields=costInLocalCurrency,dateRange`;

    const response = await axios.get(url, { headers: getHeaders() });
    const elements = response.data.elements || [];
    const totalCost = elements.reduce((sum, row) => sum + (parseFloat(row.costInLocalCurrency) || 0), 0);
    const analytics = elements.length ? { costInLocalCurrency: String(totalCost) } : { costInLocalCurrency: '0' };
    res.json({ analytics });
  } catch (error) {
    console.error('Error fetching analytics:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch analytics',
      details: error.response?.data || error.message
    });
  }
});

// Get campaign details including budget and bid
app.get('/api/campaigns/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    if (!adAccountId) {
      return res.status(400).json({ error: 'No ad account selected' });
    }

    const response = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns/${campaignId}`,
      { headers: getHeaders() }
    );

    res.json({ campaign: response.data });
  } catch (error) {
    console.error('Error fetching campaign:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch campaign',
      details: error.response?.data || error.message
    });
  }
});

// Update campaign bid
app.patch('/api/campaigns/:campaignId/bid', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { newBid, previousBid, revert } = req.body;

    if (!adAccountId) {
      return res.status(400).json({ error: 'No ad account selected' });
    }
    if (!newBid || newBid <= 0) {
      return res.status(400).json({ error: 'Invalid bid amount' });
    }

    // Get campaign to read its currency
    const campaignRes = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns/${campaignId}`,
      { headers: getHeaders() }
    );
    const campaign = campaignRes.data;
    const currencyCode = campaign.dailyBudget?.currencyCode || campaign.unitCost?.currencyCode || 'USD';

    // Update the campaign bid using LinkedIn's partial update
    await axios.post(
      `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns/${campaignId}`,
      {
        patch: {
          $set: {
            unitCost: {
              amount: (Math.round(newBid * 100) / 100).toFixed(2),
              currencyCode
            }
          }
        }
      },
      {
        headers: {
          ...getHeaders(),
          'X-RestLi-Method': 'PARTIAL_UPDATE'
        }
      }
    );

    // Persist 48h window in DB when Supabase is configured
    if (revert) {
      await removeRecentlyOptimizedFromDb(adAccountId, campaignId);
    } else if (previousBid != null && previousBid !== '') {
      await recordRecentlyOptimizedInDb(adAccountId, campaignId, previousBid);
    }

    res.json({ success: true, message: 'Bid updated successfully' });
  } catch (error) {
    console.error('Error updating bid:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to update bid',
      details: error.response?.data || error.message
    });
  }
});

// Get spend vs budget comparison (active campaigns only, via Search API).
// Query: bidAdjustmentPercent = 2 | 5 | 10 (default 2)
app.get('/api/spend-analysis', async (req, res) => {
  try {
    if (!adAccountId) {
      console.error('spend-analysis: adAccountId is missing');
      return res.status(400).json({ error: 'No ad account selected', details: 'Select an ad account on the account selection page.' });
    }
    const rawPct = req.query.bidAdjustmentPercent;
    const bidAdjustmentPercent = [2, 5, 10].includes(Number(rawPct)) ? Number(rawPct) : 2;
    const campaigns = await fetchAllActiveCampaigns();
    if (campaigns.length === 0) {
      console.log('spend-analysis: no active campaigns for account', adAccountId);
    }
    const today = new Date();

    // Normalize campaign id (REST can return id or $URN like urn:li:sponsoredCampaign:123)
    const getCampaignId = (c) => {
      const raw = c.id ?? c.$URN ?? c;
      if (typeof raw === 'number') return raw;
      const s = String(raw);
      return s.startsWith('urn:') ? s.split(':').pop() : s;
    };
    const campaignsWithId = campaigns.map(c => ({ ...c, _normalizedId: getCampaignId(c) }));

    // Include all campaigns (REST may not return status by default; UI still shows status when present)
    const campaignsToAnalyze = campaignsWithId;

    let analyticsData = {};
    if (campaignsToAnalyze.length > 0 && adAccountId) {
      try {
        const BATCH_SIZE = 10;
        const timeoutMs = 10000;
        const DAYS_IN_RANGE = 3;
        const headers = getHeaders();
        const accountUrn = `urn:li:sponsoredAccount:${adAccountId}`;
        const accountsParam = `List(${encodeURIComponent(accountUrn)})`;
        const endDate = new Date(today);
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - (DAYS_IN_RANGE - 1));
        const startDay = startDate.getDate();
        const startMonth = startDate.getMonth() + 1;
        const startYear = startDate.getFullYear();
        const endDay = endDate.getDate();
        const endMonth = endDate.getMonth() + 1;
        const endYear = endDate.getFullYear();
        // Match doc example: dateRange unencoded, timeGranularity=DAILY, accounts=List(urn%3Ali%3AsponsoredAccount%3A...)
        const dateRangeVal = `(start:(year:${startYear},month:${startMonth},day:${startDay}),end:(year:${endYear},month:${endMonth},day:${endDay}))`;

        for (let i = 0; i < campaignsToAnalyze.length; i += BATCH_SIZE) {
          const batch = campaignsToAnalyze.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (c) => {
              try {
                const id = c._normalizedId;
                const campaignUrn = `urn:li:sponsoredCampaign:${id}`;
                const campaignsParam = `List(${encodeURIComponent(campaignUrn)})`;
                const url = `${LINKEDIN_API_BASE}/adAnalytics?q=analytics&dateRange=${dateRangeVal}&timeGranularity=DAILY&accounts=${accountsParam}&pivot=CAMPAIGN&campaigns=${campaignsParam}&fields=costInLocalCurrency,dateRange`;
                const analyticsResponse = await axios.get(url, { headers, timeout: timeoutMs });
                const elements = analyticsResponse.data.elements || [];
                let totalCost = 0;
                for (const row of elements) {
                  if (row && row.costInLocalCurrency != null) {
                    totalCost += parseFloat(row.costInLocalCurrency) || 0;
                  }
                }
                const avgCost = elements.length ? totalCost / DAYS_IN_RANGE : 0;
                return {
                  id,
                  item: {
                    costInLocalCurrency: String(avgCost),
                    impressions: 0,
                    clicks: 0
                  }
                };
              } catch (e) {
                return { id: c._normalizedId, item: null };
              }
            })
          );
          results.forEach(({ id, item }) => { if (item) analyticsData[id] = item; });
        }
      } catch (e) {
        console.log('Analytics fetch failed, using zeros:', e.response?.data || e.message);
      }
    }

    // Build analysis for each campaign
    const analysis = campaignsToAnalyze.map(campaign => {
      const id = campaign._normalizedId;
      const dailyBudget = campaign.dailyBudget?.amount
        ? parseFloat(campaign.dailyBudget.amount)
        : 0;

      const currentBid = campaign.unitCost?.amount
        ? parseFloat(campaign.unitCost.amount)
        : 0;

      const analytics = analyticsData[id] || {};
      const dailySpend = analytics.costInLocalCurrency
        ? parseFloat(analytics.costInLocalCurrency)
        : 0;

      const spendPercentage = dailyBudget > 0
        ? (dailySpend / dailyBudget) * 100
        : 0;

      let recommendation = null;
      let recommendedBid = currentBid;
      const pct = bidAdjustmentPercent / 100;

      // Avg spend (last 3 days) vs daily budget: increase bid if under 90%, decrease if above 100%
      if (spendPercentage < 90 && currentBid > 0) {
        recommendedBid = currentBid * (1 + pct);
        recommendation = {
          action: 'increase',
          reason: `Only spending ${spendPercentage.toFixed(1)}% of daily budget`,
          currentBid,
          recommendedBid: Math.round(recommendedBid * 100) / 100,
          changePercent: bidAdjustmentPercent
        };
      }
      // Avg spend above daily budget → lower bid (same 2%/5%/10% adjustment as increase)
      else if (spendPercentage > 100 && currentBid > 0) {
        recommendedBid = currentBid * (1 - pct);
        recommendation = {
          action: 'decrease',
          reason: `Overspending at ${spendPercentage.toFixed(1)}% of daily budget`,
          currentBid,
          recommendedBid: Math.round(recommendedBid * 100) / 100,
          changePercent: -bidAdjustmentPercent
        };
      }

      const currencyCode = campaign.dailyBudget?.currencyCode || campaign.unitCost?.currencyCode || 'USD';

      return {
        id,
        name: campaign.name,
        status: campaign.status ?? 'ACTIVE',
        currencyCode,
        dailyBudget,
        dailySpend,
        spendPercentage: Math.round(spendPercentage * 10) / 10,
        currentBid,
        impressions: analytics.impressions || 0,
        clicks: analytics.clicks || 0,
        recommendation
      };
    });

    res.json({ analysis });
  } catch (error) {
    console.error('Error in spend analysis:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to analyze spend',
      details: error.response?.data || error.message
    });
  }
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bidder running on ${BASE_URL}`);
  console.log(`Make sure to add this redirect URI to your LinkedIn app: ${REDIRECT_URI}`);
});
