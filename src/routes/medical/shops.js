const express = require('express');
const { schoolSupabaseAdmin } = require('../../config/supabase');
const { verifySuperAdminMiddleware } = require('../../middleware/verifySuperAdmin');
const { getClusterServiceClient } = require('../../utils/clusterClient');

const router = express.Router();

/**
 * Retry an async operation with exponential back-off.
 * Retries only on transient network errors (ETIMEDOUT, ECONNRESET, etc.).
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isTransient =
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.type === 'system' ||
        (err.message && err.message.includes('ETIMEDOUT'));
      if (!isTransient || attempt === retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[retry] attempt ${attempt + 1} failed (${err.code || err.message}), retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function findShopAndClient(id) {
  const { data: clusters } = await schoolSupabaseAdmin.from('clusters').select('cluster_id').eq('status', 'active');
  for (const c of clusters) {
    try {
      const client = await getClusterServiceClient(c.cluster_id, 'medical');
      const { data } = await client.from('medical_profile').select('*').eq('id', id).maybeSingle();
      if (data) return { shop: data, client, cluster_id: c.cluster_id };
    } catch (err) {}
  }
  return { shop: null, client: null, cluster_id: null };
}

/**
 * @route   GET /api/v1/medical/shops
 * @desc    Get all medical shops
 * @access  Private (SuperAdmin)
 */
router.get('/shops', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { data: clusters, error } = await schoolSupabaseAdmin.from('clusters').select('cluster_id').eq('status', 'active');
    if (error) throw error;
    let allShops = [];
    let unreachable = false;

    await Promise.all((clusters || []).map(async (c) => {
      try {
        const client = await getClusterServiceClient(c.cluster_id, 'medical');
        const { data, error } = await client.from('medical_profile').select('*');
        if (error) throw error;
        allShops.push(...data);
      } catch (err) {
        console.error(`Failed to fetch medical shops from ${c.cluster_id}:`, err.message);
        unreachable = true;
      }
    }));

    allShops.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.status(200).json({
      success: true,
      data: allShops,
      cluster_unreachable: unreachable
    });
  } catch (error) {
    console.error('Failed to fetch medical shops', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const SUBSCRIPTION_STATUSES = new Set([
  'created',
  'authenticated',
  'active',
  'paused',
  'cancelled',
  'expired',
  'trial',
  'pending',
]);

const BILLING_CYCLES = new Set(['monthly', 'annual']);

/** PostgREST: table missing from schema / not exposed to API. */
function isMissingUsersTableError(err) {
  if (!err) return false;
  const msg = String(err.message || err.details || '').toLowerCase();
  return (
    err.code === 'PGRST205' ||
    err.code === '42P01' ||
    msg.includes('could not find the table') ||
    msg.includes('relation') && msg.includes('users') && msg.includes('does not exist')
  );
}

/**
 * POS tenant row: `public.users.id` = auth user id, links to `clinics`.
 * Returns null when row missing or `users` table is not deployed on this project.
 */
async function getPosUserRow(client, shopId) {
  const { data, error } = await withRetry(
    () =>
      client.from('users').select('id, clinic_id, role').eq('id', shopId).maybeSingle(),
    { retries: 2, baseDelayMs: 1000 },
  );
  if (error) {
    if (isMissingUsersTableError(error)) {
      return { data: null, usersTableMissing: true, error: null };
    }
    return { data: null, usersTableMissing: false, error };
  }
  return { data, usersTableMissing: false, error: null };
}

async function getPosUserRowPatch(client, shopId) {
  const { data, error } = await withRetry(
    () => client.from('users').select('id, clinic_id').eq('id', shopId).maybeSingle(),
    { retries: 2, baseDelayMs: 1000 },
  );
  if (error) {
    if (isMissingUsersTableError(error)) {
      return { data: null, usersTableMissing: true, error: null };
    }
    return { data: null, usersTableMissing: false, error };
  }
  return { data, usersTableMissing: false, error: null };
}

/**
 * @route   GET /api/v1/medical/shops/:id/subscription
 * @desc    Subscription + clinic linkage for a shop (medical_profile.id = users.id)
 * @access  Private (SuperAdmin)
 */
router.get(
  '/shops/:id/subscription',
  verifySuperAdminMiddleware,
  async (req, res) => {
    try {
      const shopId = req.params.id;

      const { shop, client } = await findShopAndClient(shopId);
      if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

      const { data: userRow, usersTableMissing, error: userErr } = await getPosUserRow(client, shopId);
      if (userErr) throw userErr;

      if (usersTableMissing) {
        return res.status(200).json({
          success: true,
          data: {
            linked: false,
            shop_user_id: shopId,
            message:
              'POS database is missing the public.users table (Medical POS Backend schema). ' +
              'Apply medical/Medical POS Backend/schema.sql (or expose users in Supabase) to link shops to clinics and subscriptions.',
          },
        });
      }

      if (!userRow?.clinic_id) {
        return res.status(200).json({
          success: true,
          data: {
            linked: false,
            shop_user_id: shopId,
            message:
              'No POS user/clinic linked yet. The shop owner must complete Medical POS signup or be provisioned so a users row exists.',
          },
        });
      }

      const clinicId = userRow.clinic_id;

      const [{ data: clinic, error: clinicErr }, { data: subscription, error: subErr }, plansResult, invoicesResult] =
        await Promise.all([
          withRetry(
            () =>
              client
                .from('clinics')
                .select('id, name, slug, plan, is_active, email, phone')
                .eq('id', clinicId)
                .maybeSingle(),
            { retries: 2, baseDelayMs: 1000 },
          ),
          withRetry(
            () =>
              client
                .from('clinic_subscriptions')
                .select('*')
                .eq('clinic_id', clinicId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
            { retries: 2, baseDelayMs: 1000 },
          ),
          withRetry(
            () =>
              client
                .from('subscription_plans')
                .select('*')
                .eq('is_active', true)
                .order('price_monthly', { ascending: true }),
            { retries: 2, baseDelayMs: 1000 },
          ),
          withRetry(
            () =>
              client
                .from('subscription_invoices')
                .select('id, amount, status, paid_at, created_at, razorpay_invoice_id, razorpay_payment_id')
                .eq('clinic_id', clinicId)
                .order('created_at', { ascending: false })
                .limit(50),
            { retries: 2, baseDelayMs: 1000 },
          ),
        ]);

      if (clinicErr) throw clinicErr;
      if (subErr) throw subErr;

      const plans = plansResult.error ? [] : plansResult.data || [];
      const invoices = invoicesResult.error ? [] : invoicesResult.data || [];
      if (plansResult.error) {
        console.warn('subscription_plans read failed (non-fatal):', plansResult.error.message);
      }
      if (invoicesResult.error) {
        console.warn('subscription_invoices read failed (non-fatal):', invoicesResult.error.message);
      }

      res.status(200).json({
        success: true,
        data: {
          linked: true,
          shop_user_id: shopId,
          clinic_id: clinicId,
          clinic: clinic || null,
          subscription: subscription || null,
          plans: plans || [],
          invoices: invoices || [],
        },
      });
    } catch (error) {
      console.error('Failed to fetch shop subscription', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

/**
 * @route   PATCH /api/v1/medical/shops/:id/subscription
 * @desc    Super-admin override for clinic subscription + optional clinic.plan sync
 * @access  Private (SuperAdmin)
 */
router.patch(
  '/shops/:id/subscription',
  verifySuperAdminMiddleware,
  async (req, res) => {
    try {
      const shopId = req.params.id;
      const {
        plan_name,
        status,
        billing_cycle,
        current_period_start,
        current_period_end,
        trial_end,
        cancelled_at,
        sync_clinic_plan = true,
      } = req.body || {};

      const { shop, client } = await findShopAndClient(shopId);
      if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

      const { data: userRow, usersTableMissing, error: userErr } = await getPosUserRowPatch(client, shopId);
      if (userErr) throw userErr;
      if (usersTableMissing) {
        return res.status(400).json({
          success: false,
          error:
            'Cannot update subscription: public.users is not available on this Medical Supabase project. ' +
            'Deploy the Medical POS Backend schema so users.clinic_id can link shops to clinics.',
        });
      }
      if (!userRow?.clinic_id) {
        return res.status(400).json({
          success: false,
          error: 'No POS clinic linked to this shop user. Cannot update subscription.',
        });
      }

      const clinicId = userRow.clinic_id;

      const { data: existingSub } = await withRetry(
        () =>
          client
            .from('clinic_subscriptions')
            .select('*')
            .eq('clinic_id', clinicId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        { retries: 2, baseDelayMs: 1000 },
      );

      if (status !== undefined && !SUBSCRIPTION_STATUSES.has(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Allowed: ${[...SUBSCRIPTION_STATUSES].join(', ')}`,
        });
      }
      if (billing_cycle !== undefined && !BILLING_CYCLES.has(billing_cycle)) {
        return res.status(400).json({ success: false, error: 'billing_cycle must be monthly or annual' });
      }

      if (plan_name !== undefined) {
        const { data: planRow, error: pErr } = await client
          .from('subscription_plans')
          .select('name')
          .eq('name', plan_name)
          .maybeSingle();
        if (pErr) throw pErr;
        if (!planRow) {
          return res.status(400).json({ success: false, error: 'Unknown plan_name' });
        }
      }

      const updates = {};
      if (plan_name !== undefined) updates.plan_name = plan_name;
      if (status !== undefined) updates.status = status;
      if (billing_cycle !== undefined) updates.billing_cycle = billing_cycle;
      if (current_period_start !== undefined) updates.current_period_start = current_period_start;
      if (current_period_end !== undefined) updates.current_period_end = current_period_end;
      if (trial_end !== undefined) updates.trial_end = trial_end;
      if (cancelled_at !== undefined) updates.cancelled_at = cancelled_at;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No subscription fields to update' });
      }

      let subscriptionRow = existingSub;

      if (!existingSub) {
        const insertPayload = {
          clinic_id: clinicId,
          plan_name: plan_name || 'trial',
          status: status || 'trial',
          billing_cycle: billing_cycle || 'monthly',
          ...updates,
        };
        const { data: inserted, error: insErr } = await withRetry(
          () => client.from('clinic_subscriptions').insert(insertPayload).select().single(),
          { retries: 2, baseDelayMs: 1000 },
        );
        if (insErr) throw insErr;
        subscriptionRow = inserted;
      } else {
        const { data: updated, error: updErr } = await withRetry(
          () =>
            client.from('clinic_subscriptions').update(updates).eq('id', existingSub.id).select().single(),
          { retries: 2, baseDelayMs: 1000 },
        );
        if (updErr) throw updErr;
        subscriptionRow = updated;
      }

      if (sync_clinic_plan && plan_name !== undefined) {
        await withRetry(
          () => client.from('clinics').update({ plan: plan_name }).eq('id', clinicId),
          { retries: 2, baseDelayMs: 1000 },
        ).catch((e) => console.warn('clinics.plan sync failed', e.message));
      }

      res.status(200).json({
        success: true,
        data: {
          subscription: subscriptionRow,
        },
      });
    } catch (error) {
      console.error('Failed to update shop subscription', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

/**
 * @route   POST /api/v1/medical/shops
 * @desc    Create a new medical shop
 * @access  Private (SuperAdmin)
 */
router.post('/shops', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const {
      medical_name,
      owner_name,
      email,
      password,
      gst_number,
      drug_license_number,
      address_line_1,
      address_line_2,
      city,
      state,
      pincode,
      phone_number,
      logo_url,
      plan,
      amount_paid,
      razorpay_key_id,
      razorpay_plan_id,
      trial_ends_at,
    } = req.body;

    // Basic validation
    if (
      !medical_name ||
      !owner_name ||
      !email ||
      !password ||
      !gst_number ||
      !drug_license_number ||
      !address_line_1 ||
      !city ||
      !state ||
      !pincode ||
      !phone_number
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    // 1. Auto-assign cluster
    const { data: clusters, error: clusterErr } = await schoolSupabaseAdmin
      .from('clusters')
      .select('*')
      .eq('status', 'active');

    if (clusterErr) throw clusterErr;

    const available = clusters.filter(c => (c.medical_count || 0) < c.max_schools);
    if (available.length === 0) {
      return res.status(503).json({ error: 'All clusters at capacity. Add a new cluster before onboarding more medical shops.' });
    }

    available.sort((a, b) => (a.medical_count || 0) - (b.medical_count || 0));
    const assigned = available[0];

    const targetClient = await getClusterServiceClient(assigned.cluster_id, 'medical');

    // 2. Create auth user (with retry for transient network errors)
    const { data: authData, error: authError } = await withRetry(
      () =>
        targetClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: owner_name },
        }),
      { retries: 3, baseDelayMs: 1500 },
    );

    if (authError) {
      throw new Error(`Failed to create auth user: ${authError.message}`);
    }

    const userId = authData.user.id;
    const slug = medical_name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Math.random().toString(36).substring(2, 7);

    // 2. Insert medical profile (Legacy / SuperAdmin view)
    const { data: profileData, error: profileError } = await withRetry(
      () =>
        targetClient
          .from('medical_profile')
          .insert([
            {
              id: userId,
              medical_name,
              owner_name,
              gst_number,
              drug_license_number,
              address_line_1,
              address_line_2,
              city,
              state,
              pincode,
              phone_number,
              logo_url,
              plan: plan || 'trial',
              amount_paid: amount_paid || 0,
              cluster_id: assigned.cluster_id,
              backend_url: assigned.medical_backend_url,
              razorpay_key_id: razorpay_key_id || null,
              razorpay_plan_id: razorpay_plan_id || null,
              subscription_status: 'trial',
              trial_ends_at: trial_ends_at ? new Date(trial_ends_at).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              onboarding_status: 'pending_build',
            },
          ])
          .select()
          .single(),
      { retries: 3, baseDelayMs: 1500 },
    );

    if (profileError) {
      await withRetry(() => targetClient.auth.admin.deleteUser(userId), { retries: 2 }).catch(() => {});
      throw new Error(`Failed to insert medical_profile: ${profileError.message}`);
    }

    // 3. Sync to new 'clinics' table (Multitenant schema)
    const { data: clinicData, error: clinicError } = await withRetry(
      () =>
        targetClient
          .from('clinics')
          .insert([
            {
              name: medical_name,
              slug: slug,
              address: address_line_1,
              phone: phone_number,
              email: email,
              gstin: gst_number,
              drug_licence_number: drug_license_number,
              logo_url: logo_url,
              plan: plan || 'trial'
            },
          ])
          .select()
          .single(),
      { retries: 2, baseDelayMs: 1000 },
    );

    if (!clinicError && clinicData) {
      // 4. Link user to clinic in 'users' table
      await withRetry(
        () =>
          targetClient.from('users').insert([
            {
              id: userId,
              clinic_id: clinicData.id,
              full_name: owner_name,
              phone: phone_number,
              role: 'OWNER',
              is_active: true
            },
          ]),
        { retries: 2, baseDelayMs: 1000 },
      ).catch((e) => console.warn('[sync] Failed to create users row:', e.message));
    } else if (clinicError) {
      console.warn('[sync] Failed to create clinics row:', clinicError.message);
    }

    // 5. Increment medical_count
    await schoolSupabaseAdmin
      .from('clusters')
      .update({ medical_count: (assigned.medical_count || 0) + 1 })
      .eq('cluster_id', assigned.cluster_id);

    res.status(201).json({
      success: true,
      data: profileData,
    });
  } catch (error) {
    console.error('Failed to create medical shop', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   PUT /api/v1/medical/shops/:id
 * @desc    Update a medical shop's profile fields
 * @access  Private (SuperAdmin)
 */
router.put('/shops/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      'medical_name', 'owner_name', 'gst_number', 'drug_license_number',
      'address_line_1', 'address_line_2', 'city', 'state', 'pincode',
      'phone_number', 'logo_url', 'plan', 'amount_paid',
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    const { shop, client } = await findShopAndClient(id);
    if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

    const { data: profileData, error: profileError } = await withRetry(
      () =>
        client
          .from('medical_profile')
          .update(updates)
          .eq('id', id)
          .select()
          .single(),
      { retries: 2, baseDelayMs: 1000 },
    );

    if (profileError) throw profileError;

    // Sync to 'clinics' table if linked
    try {
      const { data: userRow } = await client
        .from('users')
        .select('clinic_id')
        .eq('id', id)
        .maybeSingle();

      if (userRow?.clinic_id) {
        const clinicUpdates = {};
        if (updates.medical_name) clinicUpdates.name = updates.medical_name;
        if (updates.address_line_1) clinicUpdates.address = updates.address_line_1;
        if (updates.phone_number) clinicUpdates.phone = updates.phone_number;
        if (updates.gst_number) clinicUpdates.gstin = updates.gst_number;
        if (updates.drug_license_number) clinicUpdates.drug_licence_number = updates.drug_license_number;
        if (updates.logo_url) clinicUpdates.logo_url = updates.logo_url;

        if (Object.keys(clinicUpdates).length > 0) {
          await client.from('clinics').update(clinicUpdates).eq('id', userRow.clinic_id);
        }
      }
    } catch (syncErr) {
      console.warn('[sync] Failed to sync profile updates to clinics table:', syncErr.message);
    }

    res.status(200).json({ success: true, data: profileData });
  } catch (error) {
    console.error('Failed to update medical shop', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   PATCH /api/v1/medical/shops/:id/password
 * @desc    Change a medical shop owner's login password
 * @access  Private (SuperAdmin)
 */
router.patch('/shops/:id/password', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const { shop, client } = await findShopAndClient(id);
    if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

    const { error } = await withRetry(
      () => client.auth.admin.updateUserById(id, { password }),
      { retries: 2, baseDelayMs: 1000 },
    );

    if (error) throw error;

    res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Failed to update shop password', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   PATCH /api/v1/medical/shops/:id/verify
 * @desc    Toggle verified status for a medical shop
 * @access  Private (SuperAdmin)
 */
router.patch('/shops/:id/verify', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { verified } = req.body;

    if (typeof verified !== 'boolean') {
      return res.status(400).json({ success: false, error: 'verified must be a boolean' });
    }

    const { shop, client } = await findShopAndClient(id);
    if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

    const { data, error } = await withRetry(
      () =>
        client
          .from('medical_profile')
          .update({ verified })
          .eq('id', id)
          .select()
          .single(),
      { retries: 2, baseDelayMs: 1000 },
    );

    if (error) throw error;

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Failed to update shop verification', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   DELETE /api/v1/medical/shops/:id
 * @desc    Delete a medical shop and its auth user
 * @access  Private (SuperAdmin)
 */
router.delete('/shops/:id', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const { shop, client, cluster_id } = await findShopAndClient(id);
    if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

    const { error: profileError } = await withRetry(
      () => client.from('medical_profile').delete().eq('id', id),
      { retries: 2, baseDelayMs: 1000 },
    );
    if (profileError) throw profileError;

    if (cluster_id) {
      const { data: cluster } = await schoolSupabaseAdmin
        .from('clusters')
        .select('medical_count')
        .eq('cluster_id', cluster_id)
        .single();
      
      if (cluster) {
        await schoolSupabaseAdmin
          .from('clusters')
          .update({ medical_count: Math.max(0, (cluster.medical_count || 0) - 1) })
          .eq('cluster_id', shop.cluster_id);
      }
    }

    await withRetry(
      () => client.auth.admin.deleteUser(id),
      { retries: 2, baseDelayMs: 1000 },
    ).catch((err) => {
      console.warn(`Auth user deletion failed for ${id}: ${err.message} (profile already removed)`);
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to delete medical shop', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route   PATCH /api/v1/medical/shops/:id/onboarding-status
 * @desc    Update the onboarding status of a medical shop
 * @access  Private (SuperAdmin)
 */
router.patch('/shops/:id/onboarding-status', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending_build', 'app_delivered', 'live', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid onboarding status' });
    }

    const setObj = { onboarding_status: status };
    if (status === 'live') {
      setObj.onboarding_completed_at = new Date().toISOString();
    }

    const { shop, client } = await findShopAndClient(id);
    if (!shop) return res.status(404).json({ success: false, error: 'Shop not found' });

    const { data: updated, error } = await client
      .from('medical_profile')
      .update(setObj)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    console.error('Error updating medical onboarding status:', err);
    return res.status(500).json({ success: false, error: 'Failed to update onboarding status' });
  }
});

/**
 * @route   GET /api/v1/medical/shops/:id/build-config
 * @desc    Get the build configuration for a medical shop
 * @access  Private (SuperAdmin)
 */
router.get('/shops/:id/build-config', verifySuperAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { shop, cluster_id } = await findShopAndClient(id);
    if (!shop) {
      return res.status(404).json({ success: false, error: 'Shop not found' });
    }

    const { data: cluster, error: clusterErr } = await schoolSupabaseAdmin
      .from('clusters')
      .select('*')
      .eq('cluster_id', cluster_id || 'cluster_a')
      .single();

    if (clusterErr || !cluster) {
      return res.status(404).json({ success: false, error: 'Assigned cluster not found' });
    }

    const env_file = `VITE_MEDICAL_SHOP_ID=${shop.id}
VITE_SHOP_NAME="${shop.medical_name}"
VITE_API_URL=${cluster.medical_backend_url}
VITE_SUPABASE_URL=${cluster.medical_supabase_url}
VITE_SUPABASE_ANON_KEY=${cluster.medical_anon_key}
VITE_RAZORPAY_KEY_ID=${shop.razorpay_key_id || ''}
`;

    const sanitizedShopName = shop.medical_name.toLowerCase().replace(/[^a-z0-9]/g, '');

    const tauri_config_changes = {
      productName: shop.medical_name,
      identifier: `com.nexsyrus.medicpos.${sanitizedShopName}`,
      version: "1.0.0"
    };

    const setup_commands = [
      "npm install",
      "npm run tauri build"
    ];

    const subscription_info = {
      razorpay_plan_id: shop.razorpay_plan_id || null,
      subscription_status: shop.subscription_status || 'trial',
      trial_ends_at: shop.trial_ends_at || null
    };

    return res.status(200).json({
      success: true,
      data: {
        env_file,
        tauri_config_changes,
        setup_commands,
        subscription_info
      }
    });
  } catch (err) {
    console.error('Error generating medical build config:', err);
    res.status(500).json({ success: false, error: 'Failed to generate build config' });
  }
});

module.exports = router;
