"use strict";
// ===== ENTERPRISE SAAS BILLING & CUSTOMER PORTAL (TypeScript) =====
(function () {
    function authHeaders() {
        const token = localStorage.getItem('sq_token') || '';
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    }
    async function apiGet(url) {
        const r = await fetch(url, { headers: authHeaders() });
        return r.json();
    }
    async function apiPost(url, body) {
        const r = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
        return r.json();
    }
    // ─── SUPERADMIN ENTERPRISE BILLING LOADER ──────────────────────
    window.loadBillingOverview = async function () {
        try {
            const data = await apiGet('/api/billing/overview');
            if (!data.success)
                return;
            const a = data.analytics;
            const rs = data.riskSummary || {};
            // Smart Dashboard Top Widgets
            const smartEl = $id('billing-smart-widgets');
            if (smartEl) {
                smartEl.innerHTML = `
          <div class="kpi"><div class="kpi-val text-success">₹${a.totalRevenue}</div><div class="kpi-lbl">REVENUE (ALL-TIME)</div></div>
          <div class="kpi"><div class="kpi-val text-primary">${a.activeCount}</div><div class="kpi-lbl">ACTIVE SUBSCRIPTIONS</div></div>
          <div class="kpi"><div class="kpi-val text-warning">${a.abandonedCount}</div><div class="kpi-lbl">ATTENTION / PENDING</div></div>
          <div class="kpi"><div class="kpi-val text-danger">${rs.highRiskCount || 0}</div><div class="kpi-lbl">RISK ALERTS</div></div>
        `;
            }
            // Notification Bell Badge
            const nBadge = $id('billing-notif-badge');
            if (nBadge) {
                nBadge.textContent = String(data.unreadNotifications || 0);
                nBadge.classList.toggle('hidden', !data.unreadNotifications);
            }
            // Analytics Pane
            const anEl = $id('billing-analytics-grid');
            if (anEl) {
                anEl.innerHTML = `
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-val text-success">₹${a.mrr}</div><div class="kpi-lbl">MRR</div></div>
            <div class="kpi"><div class="kpi-val text-primary">₹${a.arr}</div><div class="kpi-lbl">ARR</div></div>
            <div class="kpi"><div class="kpi-val">${a.revenueGrowthPct}%</div><div class="kpi-lbl">REVENUE GROWTH</div></div>
            <div class="kpi"><div class="kpi-val">₹${a.avgTransactionValue}</div><div class="kpi-lbl">AVG TXN VALUE</div></div>
            <div class="kpi"><div class="kpi-val">₹${a.forecastNextMonth}</div><div class="kpi-lbl">NEXT MONTH FORECAST</div></div>
          </div>
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-val text-success">${a.conversionRate}%</div><div class="kpi-lbl">CONVERSION RATE</div></div>
            <div class="kpi"><div class="kpi-val text-primary">${a.renewalRate}%</div><div class="kpi-lbl">RENEWAL RATE</div></div>
            <div class="kpi"><div class="kpi-val text-warning">${a.churnRate}%</div><div class="kpi-lbl">CHURN RATE</div></div>
            <div class="kpi"><div class="kpi-val text-danger">${a.refundRate}%</div><div class="kpi-lbl">REFUND RATE</div></div>
            <div class="kpi"><div class="kpi-val">₹${a.quizRevenue} / ₹${a.aiRevenue}</div><div class="kpi-lbl">SUBS VS AI REV</div></div>
          </div>
          <div class="dash-grid mt-2">
            <div class="card">
              <div class="card-head"><span class="card-title"><i class="bi bi-lightbulb-fill text-warning me-1"></i> SMART INSIGHTS</span></div>
              <div style="padding:14px">${(a.insights || []).map((i) => `<div class="alert alert-info py-2 px-3 mb-2 text-xs fw-bold">${i}</div>`).join('')}</div>
            </div>
            <div class="card">
              <div class="card-head"><span class="card-title"><i class="bi bi-calendar3 me-1"></i> PAYMENT HEATMAP (BY DAY)</span></div>
              <div style="padding:14px;display:flex;gap:8px;flex-wrap:wrap">
                ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                    .map((d) => {
                    const cnt = a.heatmap?.[d] || 0;
                    const cls = cnt >= 5 ? 'badge-green' : cnt >= 1 ? 'badge-cyan' : 'badge-gray';
                    return `<div class="p-2 border rounded text-center" style="min-width:64px"><div class="text-xs fw-bold">${d}</div><span class="badge ${cls} mt-1">${cnt}</span></div>`;
                })
                    .join('')}
              </div>
            </div>
          </div>
          <div class="dash-grid mt-2">
            <div class="card">
              <div class="card-head"><span class="card-title"><i class="bi bi-award-fill text-primary me-1"></i> TOP CUSTOMERS</span></div>
              <div class="table-responsive"><table class="data-table"><thead><tr><th>USER</th><th>TOTAL SPENT</th></tr></thead><tbody>
                ${(a.topCustomers || []).map((c) => `<tr><td class="fw-bold">${c.userId}</td><td class="text-success fw-bold">₹${c.totalSpent}</td></tr>`).join('') || '<tr><td colspan="2" class="text-muted text-center p-12">No customer revenue yet</td></tr>'}
              </tbody></table></div>
            </div>
            <div class="card">
              <div class="card-head"><span class="card-title"><i class="bi bi-graph-up me-1"></i> MONTHLY REVENUE TREND</span></div>
              <div style="padding:14px">
                ${(a.monthlyTrend || [])
                    .map((m) => `<div class="d-flex justify-content-between align-items-center py-1 border-bottom text-xs"><span class="font-mono">${m.month}</span><strong class="text-success">₹${m.revenue}</strong></div>`)
                    .join('') || '<div class="text-muted text-xs">No monthly trend data yet.</div>'}
              </div>
            </div>
          </div>
        `;
            }
        }
        catch (e) {
            console.error('[BillingOverview]', e);
        }
    };
    // ─── SUBSCRIPTIONS LIFECYCLE ───────────────────────────────────
    window.loadBillingSubscriptions = async function () {
        const tbody = $id('billing-subs-body');
        if (!tbody)
            return;
        const data = await apiGet('/api/billing/subscriptions');
        const subs = data.subscriptions || [];
        tbody.innerHTML = subs.length
            ? subs
                .map((s) => `<tr>
          <td class="fw-bold">${s.adminId || 'Admin'}</td>
          <td><code>${s.activationCode}</code><br><span class="text-xs text-muted">${s.planTier || 'Standard'}</span></td>
          <td><span class="badge ${s.lifecycle === 'ACTIVE' ? 'badge-green' : s.lifecycle === 'RENEWAL_DUE' ? 'badge-gold' : 'badge-red'}">${s.lifecycle}</span></td>
          <td class="text-xs">${s.remainingDays}d left<br><span class="text-muted">Quizzes: ${s.remainingQuizzes}/${s.quizLimit}</span></td>
          <td><span class="badge ${s.autoRenew ? 'badge-cyan' : 'badge-gray'}">${s.autoRenew ? 'AUTO-ON' : 'MANUAL'}</span></td>
          <td class="d-flex gap-1 flex-wrap">
            <button class="btn-sm btn-cyan" onclick="subAction('${s.activationCode}','toggle_autorenew')">🔄 AUTO</button>
            <button class="btn-sm btn-gold" onclick="subAction('${s.activationCode}','${s.lifecycle === 'PAUSED' ? 'resume' : 'pause'}')">${s.lifecycle === 'PAUSED' ? '▶ RESUME' : '⏸ PAUSE'}</button>
            <button class="btn-sm btn-green" onclick="subExtend('${s.activationCode}')">+7D EXTEND</button>
            <button class="btn-sm btn-red" onclick="subAction('${s.activationCode}','cancel')">✕ CANCEL</button>
          </td>
        </tr>`)
                .join('')
            : '<tr><td colspan="6" class="text-center p-12 text-muted">No subscriptions found.</td></tr>';
    };
    window.subAction = async function (code, action) {
        const res = await apiPost(`/api/billing/subscriptions/${encodeURIComponent(code)}/action`, { action });
        if (res.success) {
            toast(`Subscription ${action} successful!`, 'success');
            window.loadBillingSubscriptions?.();
        }
        else {
            toast(res.detail || 'Action failed', 'error');
        }
    };
    window.subExtend = async function (code) {
        const res = await apiPost(`/api/billing/subscriptions/${encodeURIComponent(code)}/action`, { action: 'extend', days: 7, quizzes: 1 });
        if (res.success) {
            toast('Extended subscription by 7 days & +1 quiz credit!', 'success');
            window.loadBillingSubscriptions?.();
        }
    };
    // ─── AI CREDITS WALLET ─────────────────────────────────────────
    window.loadAIWalletTab = async function () {
        const data = await apiGet('/api/billing/ai-wallet');
        if (!data.success)
            return;
        const sumEl = $id('ai-wallet-summary');
        if (sumEl) {
            sumEl.innerHTML = `
        <div class="kpi"><div class="kpi-val text-primary">${data.totalPurchased}</div><div class="kpi-lbl">PURCHASED CREDITS</div></div>
        <div class="kpi"><div class="kpi-val text-warning">${data.totalUsed}</div><div class="kpi-lbl">USED CREDITS</div></div>
        <div class="kpi"><div class="kpi-val text-success">${data.totalRemaining}</div><div class="kpi-lbl">REMAINING CREDITS</div></div>
      `;
        }
        const wBody = $id('ai-wallets-body');
        if (wBody) {
            wBody.innerHTML = (data.wallets || [])
                .map((w) => `<tr>
        <td class="fw-bold">${w.userId}</td>
        <td>${w.purchasedCredits || 0}</td>
        <td>${w.usedCredits || 0}</td>
        <td class="fw-bold text-success">${w.remainingCredits || 0}</td>
        <td>${w.dailyUsed || 0} / ${w.dailyLimit || 50}</td>
        <td>
          <button class="btn-sm btn-green" onclick="adjustAICredits('${w.userId}', 5)">+5</button>
          <button class="btn-sm btn-red ms-1" onclick="adjustAICredits('${w.userId}', -5)">-5</button>
        </td>
      </tr>`)
                .join('') || '<tr><td colspan="6" class="text-center p-12 text-muted">No AI wallets yet.</td></tr>';
        }
    };
    window.adjustAICredits = async function (userId, delta) {
        const res = await apiPost('/api/billing/ai-wallet', { userId, delta, reason: 'SuperAdmin manual adjustment' });
        if (res.success) {
            toast(`Updated AI credits for ${userId} (${delta > 0 ? '+' : ''}${delta})`, 'success');
            window.loadAIWalletTab?.();
        }
    };
    window.grantAICreditsForm = async function () {
        const userId = $id('aiw-user-id')?.value.trim();
        const delta = parseInt($id('aiw-delta')?.value || '10', 10);
        if (!userId)
            return toast('Enter User ID / Name', 'error');
        await window.adjustAICredits(userId, delta);
    };
    // ─── FRAUD & RISK MONITOR ──────────────────────────────────────
    window.loadRiskTab = async function () {
        const data = await apiGet('/api/billing/risk');
        if (!data.success)
            return;
        const tbody = $id('risk-txns-body');
        if (tbody) {
            tbody.innerHTML = (data.transactions || [])
                .map((t) => `<tr>
        <td class="font-mono text-xs">${t.order_id}</td>
        <td class="fw-bold">${t.user_id}</td>
        <td>₹${((t.amount || 0) / 100).toFixed(2)}</td>
        <td><span class="badge ${t.riskLevel === 'HIGH' ? 'badge-red' : t.riskLevel === 'MEDIUM' ? 'badge-gold' : 'badge-green'}">${t.riskScore} (${t.riskLevel})</span></td>
        <td class="text-xs text-muted">${(t.reasons || []).join(', ') || 'Normal'}</td>
        <td><button class="btn-sm btn-red" onclick="flagSuspiciousUser('${t.user_id}')">🚩 FLAG USER</button></td>
      </tr>`)
                .join('') || '<tr><td colspan="6" class="text-center p-12 text-muted">No risk data.</td></tr>';
        }
    };
    window.flagSuspiciousUser = async function (userId) {
        const reason = prompt(`Flag ${userId} for review:`, 'Suspicious payment pattern');
        if (!reason)
            return;
        const res = await apiPost('/api/billing/risk', { userId, flagged: true, reason });
        if (res.success) {
            toast(`User ${userId} flagged for admin review`, 'warning');
            window.loadRiskTab?.();
        }
    };
    // ─── NOTIFICATIONS CENTER ──────────────────────────────────────
    window.loadBillingNotifications = async function () {
        const data = await apiGet('/api/billing/notifications');
        if (!data.success)
            return;
        const badge = $id('billing-notif-badge');
        if (badge) {
            badge.textContent = String(data.unreadCount || 0);
            badge.classList.toggle('hidden', !data.unreadCount);
        }
        const listEl = $id('billing-notifs-list');
        if (listEl) {
            listEl.innerHTML = (data.notifications || []).length
                ? data.notifications
                    .map((n) => `<div class="p-3 border-bottom d-flex justify-content-between align-items-start ${n.read ? 'opacity-75' : 'bg-light'}">
            <div>
              <span class="badge ${n.category === 'error' ? 'badge-red' : n.category === 'warning' ? 'badge-gold' : n.category === 'success' ? 'badge-green' : 'badge-cyan'} me-2">${(n.category || 'INFO').toUpperCase()}</span>
              <strong>${n.title}</strong>
              <div class="text-xs text-muted mt-1">${n.message} • ${new Date(n.createdAt).toLocaleString('en-IN')}</div>
            </div>
            ${!n.read ? `<button class="btn-sm btn-cyan" onclick="markNotifRead('${n.id}')">READ</button>` : '<span class="text-xs text-muted">Read</span>'}
          </div>`)
                    .join('')
                : '<div class="empty-state">No billing notifications.</div>';
        }
    };
    window.markNotifRead = async function (id) {
        await apiPost('/api/billing/notifications', id ? { id } : {});
        window.loadBillingNotifications?.();
    };
    // ─── COUPONS & MARKETING ───────────────────────────────────────
    window.loadCouponsTab = async function () {
        const data = await apiGet('/api/billing/coupons');
        const tbody = $id('coupons-body');
        if (!tbody)
            return;
        tbody.innerHTML = (data.coupons || [])
            .map((c) => `<tr>
        <td><code class="fw-bold">${c.code}</code></td>
        <td>${c.discountType === 'fixed' ? `₹${c.discountValue}` : `${c.discountValue}%`}</td>
        <td>${c.campaign || 'General'}</td>
        <td>${c.usedCount || 0} / ${c.maxRedemptions || 100}</td>
        <td class="text-xs text-muted">${new Date(c.expiresAt).toLocaleDateString('en-IN')}</td>
        <td><span class="badge ${c.active ? 'badge-green' : 'badge-gray'}">${c.active ? 'ACTIVE' : 'INACTIVE'}</span></td>
      </tr>`)
            .join('') || '<tr><td colspan="6" class="text-center p-12 text-muted">No coupons created yet.</td></tr>';
    };
    window.createCouponForm = async function () {
        const code = $id('cpn-code')?.value.trim();
        const discountType = $id('cpn-type')?.value || 'percent';
        const discountValue = parseFloat($id('cpn-val')?.value || '10');
        const campaign = $id('cpn-camp')?.value.trim() || 'Promo';
        const maxRedemptions = parseInt($id('cpn-max')?.value || '100', 10);
        const res = await apiPost('/api/billing/coupons', { code, discountType, discountValue, campaign, maxRedemptions });
        if (res.success) {
            toast(`Coupon ${res.coupon.code} created!`, 'success');
            window.loadCouponsTab?.();
        }
    };
    window.bulkCreateCouponsForm = async function () {
        const res = await apiPost('/api/billing/coupons/bulk', { prefix: 'QUIZPRO', count: 5, discountType: 'percent', discountValue: 20, campaign: 'Bulk Offer' });
        if (res.success) {
            toast(`Generated ${res.count} bulk coupons!`, 'success');
            window.loadCouponsTab?.();
        }
    };
    // ─── GATEWAY HEALTH ────────────────────────────────────────────
    window.loadGatewayHealthTab = async function () {
        const el = $id('gateway-health-card');
        if (!el)
            return;
        const data = await apiGet('/api/billing/gateway-health');
        if (!data.success)
            return;
        el.innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-val">${data.mode}</div><div class="kpi-lbl">GATEWAY MODE</div></div>
        <div class="kpi"><div class="kpi-val ${data.apiConnected ? 'text-success' : 'text-danger'}">${data.apiConnected ? 'CONNECTED' : 'OFFLINE'}</div><div class="kpi-lbl">API STATUS</div></div>
        <div class="kpi"><div class="kpi-val">${data.latencyMs}ms</div><div class="kpi-lbl">RESPONSE LATENCY</div></div>
        <div class="kpi"><div class="kpi-val text-success">${data.successRate}%</div><div class="kpi-lbl">PAYMENT SUCCESS RATE</div></div>
      </div>
      ${data.error ? `<div class="alert alert-warning text-xs mt-2">Gateway Note: ${data.error}</div>` : ''}
    `;
    };
    // ─── ROLES, REFUNDS, TICKETS & AUDIT ───────────────────────────
    window.loadGovernanceTab = async function () {
        const [rData, refData, tktData, audData] = await Promise.all([
            apiGet('/api/billing/roles'),
            apiGet('/api/billing/refunds'),
            apiGet('/api/billing/tickets'),
            apiGet('/api/billing/audit'),
        ]);
        const rBody = $id('roles-body');
        if (rBody) {
            rBody.innerHTML = (rData.roles || [])
                .map((r) => `<tr><td class="fw-bold">${r.adminId}</td><td><span class="badge badge-purple">${r.billingRole}</span></td><td class="text-xs text-muted">${(r.permissions || []).join(', ')}</td></tr>`)
                .join('');
        }
        const refBody = $id('refunds-body');
        if (refBody) {
            refBody.innerHTML = (refData.refunds || [])
                .map((rf) => `<tr>
          <td class="font-mono text-xs">${rf.id}</td>
          <td>${rf.userId}</td>
          <td>₹${rf.amount}</td>
          <td class="text-xs">${rf.reason}</td>
          <td><span class="badge ${rf.status === 'APPROVED' ? 'badge-green' : rf.status === 'REJECTED' ? 'badge-red' : 'badge-gold'}">${rf.status}</span></td>
          <td>${rf.status === 'PENDING' ? `<button class="btn-sm btn-green" onclick="reviewRefund('${rf.id}','approve')">APPROVE</button> <button class="btn-sm btn-red" onclick="reviewRefund('${rf.id}','reject')">REJECT</button>` : '—'}</td>
        </tr>`)
                .join('') || '<tr><td colspan="6" class="text-center p-12 text-muted">No refund requests.</td></tr>';
        }
        const tBody = $id('tickets-body');
        if (tBody) {
            tBody.innerHTML = (tktData.tickets || [])
                .map((t) => `<tr>
          <td class="font-mono text-xs">${t.id}</td>
          <td>${t.userId}</td>
          <td class="fw-bold">${t.subject}</td>
          <td><span class="badge ${t.status === 'RESOLVED' ? 'badge-green' : 'badge-gold'}">${t.status}</span></td>
          <td>${t.status === 'OPEN' ? `<button class="btn-sm btn-cyan" onclick="resolveTicket('${t.id}')">RESOLVE</button>` : '—'}</td>
        </tr>`)
                .join('') || '<tr><td colspan="5" class="text-center p-12 text-muted">No support tickets.</td></tr>';
        }
        const aBody = $id('audit-body');
        if (aBody) {
            aBody.innerHTML = (audData.audit || [])
                .slice(0, 30)
                .map((a) => `<tr><td class="text-xs text-muted">${new Date(a.createdAt).toLocaleString('en-IN')}</td><td class="fw-bold">${a.actor}</td><td><span class="badge badge-cyan">${a.action}</span></td><td class="text-xs">${a.target} ${a.details || ''}</td></tr>`)
                .join('') || '<tr><td colspan="4" class="text-center p-12 text-muted">No audit logs yet.</td></tr>';
        }
    };
    window.assignRoleForm = async function () {
        const adminId = $id('role-admin-id')?.value.trim();
        const billingRole = $id('role-select')?.value;
        if (!adminId)
            return toast('Enter Admin ID/Name', 'error');
        const res = await apiPost('/api/billing/roles', { adminId, billingRole });
        if (res.success) {
            toast('Role assigned!', 'success');
            window.loadGovernanceTab?.();
        }
    };
    window.reviewRefund = async function (id, action) {
        const res = await apiPost('/api/billing/refunds', { id, action });
        if (res.success) {
            toast(`Refund ${res.status}`, 'success');
            window.loadGovernanceTab?.();
        }
    };
    window.resolveTicket = async function (id) {
        const res = await apiPost('/api/billing/tickets', { id, action: 'resolve', reply: 'Resolved by Support Admin' });
        if (res.success) {
            toast('Ticket resolved!', 'success');
            window.loadGovernanceTab?.();
        }
    };
    // ─── CUSTOMER BILLING PORTAL (ADMIN) ───────────────────────────
    window.loadCustomerBillingPortal = async function () {
        const data = await apiGet('/api/billing/portal');
        if (!data.success)
            return;
        const w = data.wallet || {};
        const subs = data.subscriptions || [];
        const activeSub = subs.find((s) => s.lifecycle === 'ACTIVE' || s.lifecycle === 'RENEWAL_DUE') || subs[0];
        const subEl = $id('portal-sub-card');
        if (subEl) {
            if (activeSub) {
                subEl.innerHTML = `
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="badge ${activeSub.lifecycle === 'ACTIVE' ? 'badge-green' : 'badge-gold'}">${activeSub.lifecycle}</span>
            <span class="text-xs fw-bold">${activeSub.remainingDays} days left</span>
          </div>
          <div class="fw-bold fs-5 mb-1">Code: <code>${activeSub.activationCode}</code></div>
          <div class="text-xs text-muted mb-3">Quizzes Remaining: <strong>${activeSub.remainingQuizzes}</strong> / ${activeSub.quizLimit} • Auto-Renew: <strong>${activeSub.autoRenew ? 'ON' : 'OFF'}</strong></div>
          <div class="d-flex gap-2 flex-wrap">
            <button class="btn-sm btn-green" onclick="startRazorpayPayment(true)">🔄 RENEW / UPGRADE</button>
            <button class="btn-sm btn-cyan" onclick="subAction('${activeSub.activationCode}','toggle_autorenew').then(()=>loadCustomerBillingPortal())">TOGGLE AUTO-RENEW</button>
          </div>
        `;
            }
            else {
                subEl.innerHTML = `<div class="text-muted text-sm mb-3">No active subscription yet.</div><button class="btn-main btn-gold" onclick="startRazorpayPayment(true)">⚡ PURCHASE PLAN</button>`;
            }
        }
        const aiEl = $id('portal-ai-wallet');
        if (aiEl) {
            aiEl.innerHTML = `
        <div class="d-flex justify-content-between text-sm mb-2"><span>Remaining AI Credits</span><strong class="text-success">${w.remainingCredits || 0}</strong></div>
        <div class="d-flex justify-content-between text-xs text-muted mb-1"><span>Purchased</span><span>${w.purchasedCredits || 0}</span></div>
        <div class="d-flex justify-content-between text-xs text-muted"><span>Daily Usage</span><span>${w.dailyUsed || 0} / ${w.dailyLimit || 50}</span></div>
      `;
        }
        if (data.address) {
            if ($id('ba-company'))
                $id('ba-company').value = data.address.company || '';
            if ($id('ba-gstin'))
                $id('ba-gstin').value = data.address.gstin || '';
            if ($id('ba-address'))
                $id('ba-address').value = data.address.address || '';
            if ($id('ba-city'))
                $id('ba-city').value = data.address.city || '';
        }
        const txBody = $id('portal-txns-body');
        if (txBody) {
            const token = localStorage.getItem('sq_token') || '';
            txBody.innerHTML = (data.payments || [])
                .map((p) => `<tr>
          <td class="font-mono text-xs">${p.payment_id || p.order_id}</td>
          <td class="text-xs text-muted">${new Date(p.created_at || Date.now()).toLocaleString('en-IN')}</td>
          <td class="fw-bold text-success">₹${((p.amount || 0) / 100).toFixed(2)}</td>
          <td><span class="badge ${p.status === 'paid' ? 'badge-green' : p.status === 'failed' ? 'badge-red' : 'badge-gold'}">${(p.status || 'PENDING').toUpperCase()}</span></td>
          <td>
            <a class="btn-sm btn-cyan" href="/api/billing/invoice/${encodeURIComponent(p.order_id)}.pdf?token=${encodeURIComponent(token)}" target="_blank"><i class="bi bi-file-earmark-pdf"></i> INVOICE</a>
          </td>
        </tr>`)
                .join('') || '<tr><td colspan="5" class="text-center p-12 text-muted">No transactions found.</td></tr>';
        }
    };
    window.applyPortalCoupon = async function () {
        const code = $id('portal-coupon-input')?.value.trim();
        const resEl = $id('portal-coupon-res');
        if (!code)
            return;
        const res = await apiPost('/api/billing/coupons/validate', { code });
        if (resEl) {
            resEl.innerHTML = res.success
                ? `<span class="text-success fw-bold">✓ ${res.message} Final Price: ₹${res.finalAmount}</span>`
                : `<span class="text-danger fw-bold">✕ ${res.message}</span>`;
        }
    };
    window.saveBillingAddress = async function () {
        const res = await apiPost('/api/billing/address', {
            company: $id('ba-company')?.value || '',
            gstin: $id('ba-gstin')?.value || '',
            address: $id('ba-address')?.value || '',
            city: $id('ba-city')?.value || '',
        });
        if (res.success)
            toast('Billing address & GSTIN saved!', 'success');
    };
    window.submitSupportTicket = async function () {
        const subject = $id('tkt-subject')?.value.trim();
        const message = $id('tkt-msg')?.value.trim();
        if (!subject || !message)
            return toast('Enter subject and message', 'error');
        const res = await apiPost('/api/billing/tickets', { subject, message });
        if (res.success) {
            toast(`Support ticket ${res.ticket.id} submitted!`, 'success');
            if ($id('tkt-subject'))
                $id('tkt-subject').value = '';
            if ($id('tkt-msg'))
                $id('tkt-msg').value = '';
        }
    };
})();
