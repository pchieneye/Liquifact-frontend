/**
 * V1 API Router — Invoice endpoints with full DB persistence and tenant isolation.
 *
 * Replaces the former in-memory `invoices` array with service-layer calls
 * backed by Knex (sqlite3 in dev/test, PostgreSQL in production).
 *
 * Middleware stack per invoice route:
 *   extractTenant  → resolves req.tenantId from header or JWT claim
 *   route handler  → delegates all persistence to invoiceService
 *   next(err)      → bubbles to the global errorHandler / problemJsonHandler
 *
 * @module routes/v1/index
 */

'use strict';

const express = require('express');

const router = express.Router();
const investRoutes = require('../invest');
const smeRouter = require('../sme');
const { extractTenant } = require('../../middleware/tenant');
const invoiceService = require('../../services/invoiceService');
const AppError = require('../../errors/AppError');
const { invoiceCreateSchema, invoiceUpdateSchema, parseValidationErrors } = require('../../schemas/invoice');
const { validatePatchFields, detectLockedFieldChange } = require('../../middleware/patchInvoice');

// ── Sub-router mounts ────────────────────────────────────────────────────────
router.use('/invest', investRoutes);
router.use('/sme', smeRouter);

// ── Utility routes ───────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  return res.json({
    status: 'ok',
    service: 'liquifact-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

router.get('/', (req, res) => {
  return res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    version: 'v1',
    endpoints: {
      health: 'GET /v1/health',
      invoices: 'GET/POST /v1/invoices',
      escrow: 'GET/POST /v1/escrow',
      sme: 'POST /v1/sme/invoice',
    },
  });
});

// ── Invoice routes ───────────────────────────────────────────────────────────

/**
 * GET /v1/invoices
 *
 * Lists invoices for the authenticated tenant.
 * Active invoices (deleted_at IS NULL) are returned by default.
 * Pass `?includeDeleted=true` to include soft-deleted records.
 *
 * Query params:
 *   includeDeleted  {string} "true" to include soft-deleted records
 *
 * Response 200:
 *   { data: Invoice[], message: string }
 */
router.get('/invoices', extractTenant, async (req, res, next) => {
  try {
    const includeDeleted = req.query.includeDeleted === 'true';
    const invoices = await invoiceService.listInvoices(req.tenantId, { includeDeleted });

    return res.json({
      data: invoices,
      message: includeDeleted
        ? 'Showing all invoices (including deleted).'
        : 'Showing active invoices.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /v1/invoices
 *
 * Creates a new invoice scoped to the authenticated tenant.
 *
 * Request body is validated against `invoiceCreateSchema` (Zod).
 * Validation failures yield a 422 RFC 7807 Problem Details response.
 *
 * Body:
 *   amount    {number}  positive finite number (required)
 *   customer  {string}  buyer / customer name  (required — alias for `buyer`)
 *   buyer     {string}  alternative to `customer`
 *   dueDate   {string}  YYYY-MM-DD  (optional)
 *   currency  {string}  ISO 4217     (optional)
 *   description {string}            (optional)
 *   invoiceNumber {string}          (optional)
 *
 * Response 201:
 *   { data: Invoice, message: string }
 */
router.post('/invoices', extractTenant, async (req, res, next) => {
  try {
    // --- Zod validation -------------------------------------------------------
    const parsed = invoiceCreateSchema.safeParse(req.body);

    if (!parsed.success) {
      const fieldErrors = parseValidationErrors(parsed.error);
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: 'Request body contains invalid or missing fields.',
          instance: req.originalUrl,
          code: 'VALIDATION_ERROR',
          retryable: false,
          retryHint: 'Correct the highlighted fields and retry.',
          // Attach extra field-level detail for clients
          fieldErrors,
        }),
      );
    }

    const body = parsed.data;

    // Normalise buyer / customer: prefer `buyer`, fall back to `customer`
    const customerName = (body.buyer || body.customer || '').trim();

    const invoice = await invoiceService.createInvoice(
      {
        amount: body.amount,
        customer: customerName,
        currency: body.currency,
        dueDate: body.dueDate,
        description: body.description,
        invoiceNumber: body.invoiceNumber,
      },
      req.tenantId,
    );

    return res.status(201).json({
      data: invoice,
      message: 'Invoice created successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /v1/invoices/:id
 *
 * Applies validated partial updates to an invoice scoped to the authenticated tenant.
 * Uses the field guard middleware to strip unsupported keys and reject edits to
 * locked fields once an invoice reaches a protected status.
 */
router.patch('/invoices/:id', extractTenant, validatePatchFields, async (req, res, next) => {
  try {
    const parsed = invoiceUpdateSchema.safeParse(req.sanitizedUpdate);

    if (!parsed.success) {
      const fieldErrors = parseValidationErrors(parsed.error);
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: 'Request body contains invalid or missing fields.',
          instance: req.originalUrl,
          code: 'VALIDATION_ERROR',
          retryable: false,
          retryHint: 'Correct the highlighted fields and retry.',
          fieldErrors,
        }),
      );
    }

    const existingInvoice = await invoiceService.getInvoiceById(req.params.id, req.tenantId);
    if (!existingInvoice) {
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Not Found',
          status: 404,
          detail: 'Invoice not found.',
          instance: req.originalUrl,
          code: 'NOT_FOUND',
        }),
      );
    }

    const lockCheck = detectLockedFieldChange(req.sanitizedUpdate, existingInvoice.status);
    if (lockCheck.locked) {
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/validation-error',
          title: 'Validation Error',
          status: 422,
          detail: `Field '${lockCheck.field}' is locked for invoice status '${existingInvoice.status}'.`,
          instance: req.originalUrl,
          code: 'VALIDATION_ERROR',
          retryable: false,
          retryHint: 'Use a pending invoice or wait for the invoice to move back to a mutable state.',
          fieldErrors: { [lockCheck.field]: `Field '${lockCheck.field}' cannot be updated while status is '${existingInvoice.status}'.` },
        }),
      );
    }

    const updatePayload = {
      ...parsed.data,
      ...(parsed.data.customer !== undefined ? { customer: parsed.data.customer } : {}),
      ...(parsed.data.buyer !== undefined ? { customer: parsed.data.buyer } : {}),
    };

    const invoice = await invoiceService.updateInvoice(req.params.id, updatePayload, req.tenantId);

    return res.json({
      data: invoice,
      message: 'Invoice updated successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /v1/invoices/:id
 *
 * Soft-deletes an invoice scoped to the authenticated tenant.
 */
router.delete('/invoices/:id', extractTenant, async (req, res, next) => {
  try {
    const existingInvoice = await invoiceService.getInvoiceById(req.params.id, req.tenantId);
    if (!existingInvoice) {
      return next(
        new AppError({
          type: 'https://liquifact.com/probs/not-found',
          title: 'Not Found',
          status: 404,
          detail: 'Invoice not found.',
          instance: req.originalUrl,
          code: 'NOT_FOUND',
        }),
      );
    }

    const invoice = await invoiceService.deleteInvoice(req.params.id, req.tenantId);

    return res.json({
      data: invoice,
      message: 'Invoice deleted successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
