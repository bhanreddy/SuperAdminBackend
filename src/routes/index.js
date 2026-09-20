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
const crmRouter = require('./superadmin/crm');
const messengerRouter = require('./superadmin/messenger');
const contentRouter = require('./superadmin/content');
const dcgdRouter = require('./superadmin/dcgdPrograms');
const clustersRouter = require('./superadmin/clusters');
const billingRouter = require('./superadmin/billing');
const postersRouter = require('./superadmin/posters');
const backupsRouter = require('./superadmin/backups');
const sprintRouter = require('./superadmin/sprint');
const payrollRouter = require('./superadmin/payroll');
const usersRouter = require('./superadmin/users');
const requirementsRouter = require('./superadmin/requirements');
const checklistRouter = require('./superadmin/checklist');
const supportRouter = require('./superadmin/support');

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

// Top-level CRM command center
superAdmin.use('/crm', crmRouter);

// Nexsyrus Support inbox (primary shared SchoolIMS DB only)
superAdmin.use('/messenger', messengerRouter);

// Content
superAdmin.use('/content', contentRouter);

// DCGD
superAdmin.use('/dcgd', dcgdRouter);

// Client Billing (NexSyrus SaaS invoicing — tax invoice + receipt) under /billing/*
superAdmin.use('/billing', billingRouter);

// Festival posters (upload + manage) under /posters/*
superAdmin.use('/posters', postersRouter);

// Employee master, autonomous payroll and HR documents.
superAdmin.use('/payroll', payrollRouter);

// Database Backups Subsystem
superAdmin.use('/backups', backupsRouter);

// 11-Day Sprint Command Center
superAdmin.use('/sprint', sprintRouter);

// Internal Team & RBAC User Management
superAdmin.use('/users', usersRouter);

// School Requirements
superAdmin.use('/requirements', requirementsRouter);

// School Onboarding & Launch Checklist
superAdmin.use('/checklist', checklistRouter);
superAdmin.use('/schools', checklistRouter);

// Support & Complaints Command Center
superAdmin.use('/support', supportRouter);

router.use('/api/super-admin', superAdmin);

// ── Public routes (no auth — consumed by client apps) ───────────────────────
router.use('/api/public', publicRouter);

// ── Medical routes ──────────────────────────────────────────────────────────
// Exact same path the Expo app expects: /api/v1/medical/*
router.use('/api/v1/medical', medicalShopsRouter);

module.exports = router;
