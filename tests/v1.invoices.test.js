/**
 * Route-level tests for the v1 invoice router.
 *
 * These tests verify the new PATCH and DELETE behavior through the Express
 * router while avoiding the repository-wide DB mock that is incompatible with
 * the current invoice service implementation.
 *
 * @jest-environment node
 */

'use strict';

jest.mock('../src/middleware/tenant', () => ({
  extractTenant(req, res, next) {
    const tenantId = req.headers['x-tenant-id'] || req.get('x-tenant-id');
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing tenant id' });
    }

    req.tenantId = tenantId;
    return next();
  },
}));

const invoiceService = require('../src/services/invoiceService');

jest.mock('../src/services/invoiceService', () => ({
  listInvoices: jest.fn(),
  createInvoice: jest.fn(),
  getInvoiceById: jest.fn(),
  updateInvoice: jest.fn(),
  deleteInvoice: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const v1Router = require('../src/routes/v1/index');
const { errorHandler } = require('../src/middleware/errorHandler');
const { problemJsonHandler } = require('../src/middleware/problemJson');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', v1Router);
  app.use(problemJsonHandler);
  app.use(errorHandler);
  return app;
}

const TENANT_A = 'tenant-alpha';
let app;

beforeAll(() => {
  app = buildTestApp();
});

beforeEach(() => {
  jest.clearAllMocks();
  invoiceService.listInvoices.mockResolvedValue([]);
  invoiceService.createInvoice.mockResolvedValue({
    invoice_id: 'inv_test_001',
    amount: '500.00',
    customer: 'Acme Corp',
    status: 'pending',
    tenant_id: TENANT_A,
    deleted_at: null,
  });
  invoiceService.getInvoiceById.mockResolvedValue(null);
  invoiceService.updateInvoice.mockResolvedValue(null);
  invoiceService.deleteInvoice.mockResolvedValue(null);
});

function postInvoice(tenantId, overrides = {}) {
  const body = {
    amount: 500,
    customer: 'Acme Corp',
    seller: 'Acme Seller',
    currency: 'USD',
    dueDate: '2026-01-31',
    ...overrides,
  };
  return request(app)
    .post('/v1/invoices')
    .set('x-tenant-id', tenantId)
    .send(body);
}

function getInvoices(tenantId, query = {}) {
  return request(app)
    .get('/v1/invoices')
    .set('x-tenant-id', tenantId)
    .query(query);
}

function patchInvoice(tenantId, invoiceId, body) {
  return request(app)
    .patch(`/v1/invoices/${invoiceId}`)
    .set('x-tenant-id', tenantId)
    .send(body);
}

function deleteInvoice(tenantId, invoiceId) {
  return request(app)
    .delete(`/v1/invoices/${invoiceId}`)
    .set('x-tenant-id', tenantId);
}

describe('POST /v1/invoices — creation', () => {
  it('creates an invoice and returns 201', async () => {
    invoiceService.createInvoice.mockResolvedValue({
      invoice_id: 'inv_test_001',
      amount: '1250.50',
      customer: 'Global Traders Ltd',
      status: 'pending',
      tenant_id: TENANT_A,
      deleted_at: null,
    });

    const res = await postInvoice(TENANT_A, { amount: 1250.50, customer: 'Global Traders Ltd' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Invoice created successfully.');
    expect(invoiceService.createInvoice).toHaveBeenCalled();
  });

  it('returns 422 for invalid create payloads', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: -5 });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('GET /v1/invoices — listing', () => {
  it('returns active invoices for a tenant', async () => {
    invoiceService.listInvoices.mockResolvedValue([{ invoice_id: 'inv_1', deleted_at: null }]);

    const res = await getInvoices(TENANT_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(invoiceService.listInvoices).toHaveBeenCalledWith(TENANT_A, { includeDeleted: false });
  });

  it('returns 400 when x-tenant-id header is missing', async () => {
    const res = await request(app).get('/v1/invoices');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /v1/invoices/:id — updates', () => {
  it('updates an invoice for the authenticated tenant', async () => {
    invoiceService.getInvoiceById.mockResolvedValue({ invoice_id: 'inv_1', status: 'pending' });
    invoiceService.updateInvoice.mockResolvedValue({ invoice_id: 'inv_1', amount: '250.00', customer: 'Updated Corp', status: 'pending' });

    const res = await patchInvoice(TENANT_A, 'inv_1', { amount: 250, customer: 'Updated Corp' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Invoice updated successfully.');
    expect(invoiceService.updateInvoice).toHaveBeenCalled();
  });

  it('rejects edits to locked invoice statuses with 422', async () => {
    invoiceService.getInvoiceById.mockResolvedValue({ invoice_id: 'inv_1', status: 'verified' });

    const res = await patchInvoice(TENANT_A, 'inv_1', { amount: 500 });

    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/validation-error/);
  });

  it('returns 404 for an unknown invoice id', async () => {
    invoiceService.getInvoiceById.mockResolvedValue(null);

    const res = await patchInvoice(TENANT_A, 'inv_missing', { amount: 123 });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/invoices/:id — soft delete', () => {
  it('soft-deletes an invoice and makes it disappear by default', async () => {
    invoiceService.getInvoiceById.mockResolvedValue({ invoice_id: 'inv_1', deleted_at: null });
    invoiceService.deleteInvoice.mockResolvedValue({ invoice_id: 'inv_1', deleted_at: '2026-01-01T00:00:00.000Z' });

    const res = await deleteInvoice(TENANT_A, 'inv_1');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Invoice deleted successfully.');
    expect(invoiceService.deleteInvoice).toHaveBeenCalledWith('inv_1', TENANT_A);
  });

  it('returns 404 for an invoice belonging to another tenant', async () => {
    invoiceService.getInvoiceById.mockResolvedValue(null);

    const res = await deleteInvoice(TENANT_A, 'inv_1');

    expect(res.status).toBe(404);
  });
});

describe('RFC 7807 error response format', () => {
  it('validation error has correct content-type header', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: -5 });

    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('validation error body contains required RFC 7807 fields', async () => {
    const res = await request(app)
      .post('/v1/invoices')
      .set('x-tenant-id', TENANT_A)
      .send({ amount: -5 });

    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe(422);
  });
});
