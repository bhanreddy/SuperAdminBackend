const express = require('express');

// SuperAdmin sub-routers
const verifyRouter = require('./superadmin/verify');
const adminsRouter = require('./superadmin/admins');
const studentsRouter = require('./superadmin/students');
const schoolsRouter = require('./superadmin/schools');
const featuresRouter = require('./superadmin/features');
const dashboardRouter = require('./superadmin/dashboard');
const importRouter = require('./superadmin/import');
const founderAuthRouter = require('./superadmin/founderAuth');
const founderCrmRouter = require('./superadmin/founderCrm');
const contentRouter = require('./superadmin/content');
const dcgdRouter = require('./superadmin/dcgdPrograms');
const clustersRouter = require('./superadmin/clusters');
const billingRouter = require('./superadmin/billing');
const postersRouter = require('./superadmin/posters');

// Public (unauthenticated) routes
const publicRouter = require('./public');

// Medical sub-routers
const medicalShopsRouter = require('./medical/shops');

// Health
const healthRouter = require('./health');

const router = express.Router();

// ── Health ──────────────────────────────────────────────────────────────────
// GET / — liveness for load balancers & monitors; same body as GET /health
router.get('/', healthRouter.sendHealth);
router.use('/health', healthRouter);

// ── SuperAdmin routes ───────────────────────────────────────────────────────
// Exact same path prefix the Expo app expects: /api/super-admin/*
const superAdmin = express.Router();

// Auth (no middleware — login/refresh don't require a token)
superAdmin.use('/auth', founderAuthRouter);

// Verify
superAdmin.use('/', verifyRouter);

// Clusters (No Auth)
superAdmin.use('/clusters', clustersRouter);

// Admin CRUD
superAdmin.use('/admins', adminsRouter);

// Students
superAdmin.use('/students', studentsRouter);

// Schools (GET|POST /schools, PATCH /schools/:id, POST /schools/:id/seed-defaults|first-admin)
superAdmin.use('/schools', schoolsRouter);

// Per-school student feature flags (GET /schools/:schoolId/features,
// PUT /schools/:schoolId/features/:featureKey) — mounted before nothing else
// on /schools claims these paths.
superAdmin.use('/schools', featuresRouter);

// Dashboard stats (GET /dashboard/stats)
superAdmin.use('/dashboard', dashboardRouter);

// Bulk import (POST /schools/:id/students/import) — registered at super-admin level
superAdmin.use('/', importRouter);

// Founder CRM (all under /founder/*)
superAdmin.use('/founder', founderCrmRouter);

// Content
superAdmin.use('/content', contentRouter);

// DCGD
superAdmin.use('/dcgd', dcgdRouter);

// Client Billing (NexSyrus SaaS invoicing — tax invoice + receipt) under /billing/*
superAdmin.use('/billing', billingRouter);

// Festival posters (upload + manage) under /posters/*
superAdmin.use('/posters', postersRouter);

router.use('/api/super-admin', superAdmin);

// ── Public routes (no auth — consumed by client apps) ───────────────────────
router.use('/api/public', publicRouter);

// ── Medical routes ──────────────────────────────────────────────────────────
// Exact same path the Expo app expects: /api/v1/medical/*
router.use('/api/v1/medical', medicalShopsRouter);

module.exports = router;
