require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';
const LINKEDIN_V2_BASE = 'https://api.linkedin.com/v2';
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
// For deployment: set BASE_URL to your public URL (e.g. https://your-app.railway.app). No trailing slash.
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_COOKIE = 'auth';
const COOKIE_OPTS = { httpOnly: true, secure: BASE_URL.startsWith('https'), sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 };

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const multiUser = !!(supabase && JWT_SECRET);

// LinkedIn API headers — use req.user when authenticated
function getHeaders(req) {
  const token = multiUser && req && req.user ? req.user.access_token : null;
  return {
    'Authorization': `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': '202504',
    'Content-Type': 'application/json'
  };
}

// Current ad account comes from the request (query, body, or header); not stored per user.
function getAdAccountId(req) {
  if (!req) return null;
  const raw = req.query?.adAccountId ?? req.body?.adAccountId ?? (req.get && req.get('x-ad-account-id')) ?? null;
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // LinkedIn REST path expects numeric ID; strip URN prefix if present
  if (s.startsWith('urn:li:sponsoredAccount:')) return s.slice('urn:li:sponsoredAccount:'.length);
  return s;
}

async function loadUserFromToken(req, res, next) {
  req.user = null;
  if (!multiUser) return next();
  const token = req.cookies[AUTH_COOKIE];
  if (!token) return next();
  try {
    const { userId } = jwt.verify(token, JWT_SECRET);
    const { data, error } = await supabase.from('users').select('id, access_token').eq('id', userId).single();
    if (!error && data) req.user = { id: data.id, access_token: data.access_token };
  } catch (e) {}
  next();
}

app.use(loadUserFromToken);

function requireAuth(req, res, next) {
  if (multiUser && !req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Check if authenticated (current ad account is not stored; frontend sends it per request)
app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.user,
    hasAdAccount: false,
    currentAdAccountId: null
  });
});

// Log out — clear auth cookie
app.get('/auth/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.redirect('/');
});

// Start OAuth flow - redirect to LinkedIn
// Set LINKEDIN_SCOPES to include "openid profile" for one account per LinkedIn user across localhost and production (requires OpenID Connect product on your LinkedIn app).
app.get('/auth/login', (req, res) => {
  const scopes = process.env.LINKEDIN_SCOPES || 'r_ads,r_ads_reporting,rw_ads';
  const state = Math.random().toString(36).substring(7);

  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${state}`;

  res.redirect(authUrl);
});

// OAuth callback - exchange code for token; multi-user: create/update user, set JWT cookie
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
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const newAccessToken = tokenResponse.data.access_token;

    if (!multiUser) {
      return res.send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h2>Auth not configured</h2>
          <p>Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET for multi-user login.</p>
          <a href="/">Go Back</a>
        </body></html>
      `);
    }

    // Stable user ID: from OpenID userinfo (same LinkedIn account everywhere) or fallback to hash of token (different per login/env → separate rows in Supabase).
    let linkedinUserId = null;
    try {
      const userinfoRes = await axios.get(`${LINKEDIN_V2_BASE}/userinfo`, {
        headers: { Authorization: `Bearer ${newAccessToken}` }
      });
      linkedinUserId = userinfoRes?.data?.sub || userinfoRes?.data?.id || null;
    } catch (e) {
      linkedinUserId = 'token_' + crypto.createHash('sha256').update(newAccessToken).digest('hex').slice(0, 32);
    }
    if (!linkedinUserId) linkedinUserId = 'token_' + crypto.createHash('sha256').update(newAccessToken).digest('hex').slice(0, 32);

      const { data: existing } = await supabase.from('users').select('id').eq('linkedin_user_id', linkedinUserId).single();
      let userId;
      if (existing) {
        await supabase.from('users').update({
          access_token: newAccessToken,
          updated_at: new Date().toISOString()
        }).eq('id', existing.id);
        userId = existing.id;
      } else {
        const { data: inserted, error: insertErr } = await supabase.from('users').insert({
          linkedin_user_id: linkedinUserId,
          access_token: newAccessToken
        }).select('id').single();
      if (insertErr) throw insertErr;
      userId = inserted.id;
    }

    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie(AUTH_COOKIE, token, COOKIE_OPTS);
    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err.response?.data || err.message);
    res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h2>Authentication Failed</h2>
        <p>${err.response?.data?.error_description || err.message}</p>
        <a href="/">Go Back</a>
      </body></html>
    `);
  }
});

// Get ad accounts for the user; ?includeOptimization=1 adds hasOptimization per account.
// Only returns accounts that are selected for optimization (settings), unless no selection saved yet.
app.get('/api/ad-accounts', requireAuth, async (req, res) => {
  try {
    const response = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts?q=search`,
      { headers: getHeaders(req) }
    );

    let accounts = response.data.elements || [];
    const selectedIds = await readSelectedAccountIds(req);
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
          ? (await getRecentlyOptimizedFromDb(req, acc.id)).map((e) => e.campaignId)
          : recentFromQuery;
        const hasOptimization = await getAccountOptimizationStatus(req, acc.id, { excludeCampaignIds: excludeIds }).catch(() => false);
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
const SELECTED_ACCOUNTS_PATH = path.join(__dirname, 'selected-accounts.json');

async function readSelectedAccountIds(req) {
  if (supabase && req && req.user) {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('selected_account_ids')
        .eq('user_id', req.user.id)
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
  return null;
}

async function writeSelectedAccountIds(req, selectedIds) {
  if (supabase && req && req.user) {
    try {
      const { error } = await supabase.from('app_settings').upsert(
        { id: req.user.id, user_id: req.user.id, selected_account_ids: selectedIds, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
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

async function getRecentlyOptimizedFromDb(req, adAccountId) {
  if (!supabase || !adAccountId) return [];
  const cutoff = new Date(Date.now() - RECENTLY_OPTIMIZED_MS).toISOString();
  let q = supabase
    .from('recently_optimized')
    .select('campaign_id, applied_at, previous_bid')
    .eq('ad_account_id', String(adAccountId))
    .gte('applied_at', cutoff)
    .order('applied_at', { ascending: false });
  if (req && req.user) q = q.eq('user_id', req.user.id);
  else return [];
  const { data, error } = await q;
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

async function recordRecentlyOptimizedInDb(req, adAccountId, campaignId, previousBid) {
  if (!supabase || !adAccountId || !campaignId || !req || !req.user) return;
  await supabase.from('recently_optimized').delete().eq('ad_account_id', String(adAccountId)).eq('campaign_id', String(campaignId)).eq('user_id', req.user.id);
  const row = {
    ad_account_id: String(adAccountId),
    campaign_id: String(campaignId),
    applied_at: new Date().toISOString(),
    previous_bid: previousBid != null ? Number(previousBid) : null,
    user_id: req.user.id
  };
  const { error } = await supabase.from('recently_optimized').insert(row);
  if (error) console.error('Error recording recently_optimized in Supabase:', error.message);
}

async function removeRecentlyOptimizedFromDb(req, adAccountId, campaignId) {
  if (!supabase || !adAccountId || !campaignId || !req || !req.user) return;
  const { error } = await supabase.from('recently_optimized').delete().eq('ad_account_id', String(adAccountId)).eq('campaign_id', String(campaignId)).eq('user_id', req.user.id);
  if (error) console.error('Error removing from recently_optimized in Supabase:', error.message);
}

// GET /api/recently-optimized?adAccountId=xxx — list of campaigns in 48h window (for current account)
app.get('/api/recently-optimized', async (req, res) => {
  const adAccountId = req.query.adAccountId;
  if (!adAccountId) {
    return res.status(400).json({ error: 'adAccountId required' });
  }
  const useServer = !!supabase;
  const entries = useServer ? await getRecentlyOptimizedFromDb(req, adAccountId) : [];
  res.json({ entries, useServer });
});

// GET /api/settings/selected-accounts — which accounts are enabled for optimization
app.get('/api/settings/selected-accounts', async (req, res) => {
  const selectedIds = await readSelectedAccountIds(req);
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
    await writeSelectedAccountIds(req, normalized);
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
      { headers: getHeaders(req) }
    );
    const accounts = response.data.elements || [];
    const selectedIds = await readSelectedAccountIds(req);
    res.json({ accounts, selectedIds });
  } catch (error) {
    console.error('Error fetching ad accounts for settings:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch ad accounts',
      details: error.response?.data || error.message
    });
  }
});

// DELETE /api/account — delete current user's data and the user row
app.delete('/api/account', requireAuth, async (req, res) => {
  try {
    if (supabase && req.user) {
      const { error: errSettings } = await supabase.from('app_settings').delete().eq('user_id', req.user.id);
      if (errSettings) console.error('Error deleting app_settings:', errSettings.message);
      const { error: errRecent } = await supabase.from('recently_optimized').delete().eq('user_id', req.user.id);
      if (errRecent) console.error('Error deleting recently_optimized:', errRecent.message);
      const { error: errUser } = await supabase.from('users').delete().eq('id', req.user.id);
      if (errUser) console.error('Error deleting user:', errUser.message);
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

// Acknowledge ad account selection (current account is not stored; frontend sends it per request)
app.post('/api/ad-accounts/select', requireAuth, (req, res) => {
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
async function getCampaignGroupStatus(req, accountId, campaignId) {
  try {
    const url = `${LINKEDIN_API_BASE}/adAccounts/${accountId}/adCampaigns/${campaignId}`;
    const response = await axios.get(url, {
      headers: getHeaders(req),
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
async function filterCampaignsByActiveGroup(req, accountId, campaigns) {
  if (campaigns.length === 0) return [];
  const BATCH_SIZE = 10;
  const activeIds = new Set();
  for (let i = 0; i < campaigns.length; i += BATCH_SIZE) {
    const batch = campaigns.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (c) => {
        const id = getCampaignId(c);
        const status = await getCampaignGroupStatus(req, accountId, id);
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
async function fetchAllActiveCampaigns(req, adAccountId) {
  const headers = getHeaders(req);
  if (!headers.Authorization || headers.Authorization === 'Bearer null' || headers.Authorization === 'Bearer undefined') {
    console.error('fetchAllActiveCampaigns: no valid token (req.user?', !!req?.user, ')');
    const err = new Error('No valid session');
    err.status = 401;
    throw err;
  }
  const opts = { headers, timeout: REQUEST_TIMEOUT_MS };
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
      const filtered = await filterCampaignsByActiveGroup(req, adAccountId, all);
      if (filtered.length === 0) {
        console.log('fetchAllActiveCampaigns: all', all.length, 'filtered to 0 (campaign group not ACTIVE), returning unfiltered');
        return all;
      }
      return filtered;
    }
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.response?.data?.error_description || e.message;
    console.error('fetchAllActiveCampaigns: LinkedIn error', status, msg || e.response?.data);
    if (status === 401 || status === 403) {
      throw e;
    }
    if (status === 400) {
      console.log('Search API returned 400, trying fallback:', msg || e.message);
    } else {
      throw e;
    }
  }

  // Fallback: one page, no filter
  try {
    const response = await axios.get(baseUrl, { ...opts, params: { q: 'search' } });
    const raw = response.data.elements || [];
    console.log('fetchAllActiveCampaigns: fallback page elements', raw.length);
    const active = raw.filter(c => (c.status || '').toUpperCase() === 'ACTIVE');
    const candidates = active.length > 0 ? active : raw;
    const filtered = await filterCampaignsByActiveGroup(req, adAccountId, candidates);
    if (filtered.length === 0 && candidates.length > 0) {
      console.log('fetchAllActiveCampaigns: fallback filtered to 0, returning unfiltered');
      return candidates;
    }
    return filtered;
  } catch (e) {
    console.error('fetchAllActiveCampaigns: fallback failed', e.response?.status, e.response?.data?.message || e.message);
    throw e;
  }
}

// Fetch active campaigns for a specific account (for optimization status); only in ACTIVE campaign groups.
async function fetchActiveCampaignsForAccount(req, accountId) {
  const opts = { headers: getHeaders(req), timeout: REQUEST_TIMEOUT_MS };
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
    return await filterCampaignsByActiveGroup(req, accountId, candidates);
  } catch (e) {
    return [];
  }
}

// Run spend analysis for a given account; returns analysis array (used for optimization flag).
async function runSpendAnalysisForAccount(req, accountId, bidAdjustmentPercent = 2) {
  const campaigns = await fetchActiveCampaignsForAccount(req, accountId);
  const getCampaignId = (c) => {
    const raw = c.id ?? c.$URN ?? c;
    if (typeof raw === 'number') return raw;
    const s = String(raw);
    return s.startsWith('urn:') ? s.split(':').pop() : s;
  };
  const campaignsWithId = campaigns.map(c => ({ ...c, _normalizedId: getCampaignId(c) }));
  const today = new Date();
  let analyticsData = {};
  if (campaignsWithId.length > 0 && req) {
    try {
      const BATCH_SIZE = 10;
      const timeoutMs = 10000;
      const DAYS_IN_RANGE = 3;
      const headers = getHeaders(req);
      const accountUrn = `urn:li:sponsoredAccount:${accountId}`;
      const accountsParam = `List(${encodeURIComponent(accountUrn)})`;
      // Last 3 complete full days (yesterday and the two days before; exclude today)
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() - 1);
      const startDate = new Date(endDate);
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

async function getAccountOptimizationStatus(req, accountId, options = {}) {
  const analysis = await runSpendAnalysisForAccount(req, accountId).catch(() => []);
  let filtered = analysis;
  const excludeIds = options.excludeCampaignIds;
  if (excludeIds && excludeIds.length > 0) {
    const set = new Set(excludeIds.map(id => String(id)));
    filtered = analysis.filter(c => !set.has(String(c.id)));
  }
  return filtered.some(c => c.recommendation);
}

// General campaign list (one page, no filter) for /api/campaigns
async function fetchAllCampaigns(req, adAccountId) {
  const url = `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns`;
  const response = await axios.get(url, {
    headers: getHeaders(req),
    timeout: REQUEST_TIMEOUT_MS,
    params: { q: 'search' }
  });
  return response.data.elements || [];
}

// Get all campaigns for the ad account
app.get('/api/campaigns', async (req, res) => {
  try {
    const adAccountId = getAdAccountId(req);
    if (!adAccountId) return res.status(400).json({ error: 'adAccountId required (query or header X-Ad-Account-Id)' });
    const campaigns = await fetchAllCampaigns(req, adAccountId);
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
    const adAccountId = getAdAccountId(req);
    if (!adAccountId) return res.status(400).json({ error: 'adAccountId required (query or header X-Ad-Account-Id)' });
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

    const response = await axios.get(url, { headers: getHeaders(req) });
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
    const adAccountId = getAdAccountId(req);
    if (!adAccountId) return res.status(400).json({ error: 'adAccountId required (query or header X-Ad-Account-Id)' });

    const response = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts/${adAccountId}/adCampaigns/${campaignId}`,
      { headers: getHeaders(req) }
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
app.patch('/api/campaigns/:campaignId/bid', requireAuth, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { newBid, previousBid, revert } = req.body;
    const currentAdAccountId = getAdAccountId(req);

    if (!currentAdAccountId) {
      return res.status(400).json({ error: 'adAccountId required (query, body, or header X-Ad-Account-Id)' });
    }
    if (!newBid || newBid <= 0) {
      return res.status(400).json({ error: 'Invalid bid amount' });
    }

    // Get campaign to read its currency
    const campaignRes = await axios.get(
      `${LINKEDIN_API_BASE}/adAccounts/${currentAdAccountId}/adCampaigns/${campaignId}`,
      { headers: getHeaders(req) }
    );
    const campaign = campaignRes.data;
    const currencyCode = campaign.dailyBudget?.currencyCode || campaign.unitCost?.currencyCode || 'USD';

    // Update the campaign bid using LinkedIn's partial update
    await axios.post(
      `${LINKEDIN_API_BASE}/adAccounts/${currentAdAccountId}/adCampaigns/${campaignId}`,
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
          ...getHeaders(req),
          'X-RestLi-Method': 'PARTIAL_UPDATE'
        }
      }
    );

    // Persist 48h window in DB when Supabase is configured
    if (revert) {
      await removeRecentlyOptimizedFromDb(req, currentAdAccountId, campaignId);
    } else if (previousBid != null && previousBid !== '') {
      await recordRecentlyOptimizedInDb(req, currentAdAccountId, campaignId, previousBid);
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
// Query: bidAdjustmentPercent = 2 | 5 | 10 (default 2), adAccountId required
app.get('/api/spend-analysis', requireAuth, async (req, res) => {
  try {
    const adAccountId = getAdAccountId(req);
    if (!adAccountId) {
      return res.status(400).json({ error: 'adAccountId required (query or header X-Ad-Account-Id)' });
    }
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated', details: 'Sign in again.' });
    }
    const rawPct = req.query.bidAdjustmentPercent;
    const bidAdjustmentPercent = [2, 5, 10].includes(Number(rawPct)) ? Number(rawPct) : 2;
    const campaigns = await fetchAllActiveCampaigns(req, adAccountId);
    if (campaigns.length === 0) {
      console.log('spend-analysis: no active campaigns for account', adAccountId, 'hasUser:', !!req.user);
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
        const headers = getHeaders(req);
        const accountUrn = `urn:li:sponsoredAccount:${adAccountId}`;
        const accountsParam = `List(${encodeURIComponent(accountUrn)})`;
        // Last 3 complete full days (yesterday and the two days before; exclude today)
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() - 1);
        const startDate = new Date(endDate);
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
    const status = error.status === 401 || error.response?.status === 401 ? 401 : 500;
    res.status(status).json({
      error: status === 401 ? 'Not authenticated' : 'Failed to analyze spend',
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
