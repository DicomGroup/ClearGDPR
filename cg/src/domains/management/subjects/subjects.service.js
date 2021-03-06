const winston = require('winston');
const { db } = require('../../../db');
const { recordRectificationByController } = require('../../../utils/blockchain');
const { decryptFromStorage, encryptForStorage } = require('../../../utils/encryption');
const { ValidationError, NotFound, BadRequest } = require('../../../utils/errors');
const { RECTIFICATION_STATUSES } = require('./../../../utils/constants');

const PAGE_SIZE = 10; // This could go in constants, inside utils

class SubjectsService {
  constructor(database = db) {
    this.db = database;
  }

  async listSubjects(requestedPage = 1) {
    const [numberOfsubjectsObject] = await this.db('subjects')
      .join('subject_keys', 'subjects.id', '=', 'subject_keys.subject_id')
      .whereNotNull('personal_data')
      .whereNotNull('key')
      .count('personal_data');

    const numberOfsubjects = numberOfsubjectsObject.count;
    let totalPages = Math.ceil(numberOfsubjects / PAGE_SIZE);
    if (totalPages === 0) {
      // Handles the case in which there are no valid subjects, with valid encryption keys and all, in the db
      totalPages = 1;
    }
    if (requestedPage > totalPages) {
      throw new ValidationError(`page number too big, maximum page number is ${totalPages}`);
    }
    const encryptedSubjectsData = await this.db('subjects')
      .join('subject_keys', 'subjects.id', '=', 'subject_keys.subject_id')
      .select('personal_data')
      .select('subjects.id')
      .select('subjects.created_at')
      .whereNotNull('personal_data')
      .select('key')
      .whereNotNull('key')
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .offset((requestedPage - 1) * PAGE_SIZE);

    const decryptedSubjectsData = encryptedSubjectsData
      .map(subject => {
        try {
          const decryptedData = decryptFromStorage(subject.personal_data, subject.key);
          return {
            data: JSON.parse(decryptedData),
            id: subject.id,
            createdAt: subject.created_at
          };
        } catch (e) {
          winston.info(`Error decrypting data ${e.toString()}`);
          return null;
        }
      })
      .filter(subject => subject !== null);

    return {
      data: decryptedSubjectsData,
      paging: {
        current: requestedPage,
        total: totalPages
      }
    };
  }

  async listRectificationRequests(requestedPage = 1) { 
    const [{ total_items }] = await this.db('rectification_requests')
      .where('status', RECTIFICATION_STATUSES.PENDING)
      .join('subject_keys', 'rectification_requests.subject_id', 'subject_keys.subject_id')
      .select(this.db.raw('count(id) as total_items'))
      .as('total_items');

    const totalPages = Math.ceil(total_items / PAGE_SIZE || 1);
    if (requestedPage > totalPages) {
      throw new ValidationError(`Page number too big, maximum page number is ${totalPages}`);
    }
    const requests = await this.db('rectification_requests')
      .select('id')
      .select('request_reason')
      .select('rectification_requests.created_at')
      .where('status', RECTIFICATION_STATUSES.PENDING)
      .join('subject_keys', 'rectification_requests.subject_id', 'subject_keys.subject_id')
      .limit(PAGE_SIZE)
      .offset((requestedPage - 1 ) * PAGE_SIZE);

    return {
      data: requests,
      paging: {
        current: requestedPage,
        total: totalPages
      }
    };
  }

  async listProcessedRectificationRequests(requestedPage = 1) {
    const [{ total_items }] = await this.db('rectification_requests')
      .whereNot('status', RECTIFICATION_STATUSES.PENDING)
      .leftJoin('subject_keys', 'rectification_requests.subject_id', 'subject_keys.subject_id')
      .select(this.db.raw('count(id) as total_items'))
      .as('total_items');

    const totalPages = Math.ceil(total_items / PAGE_SIZE || 1);
    if (requestedPage > totalPages) {
      throw new ValidationError(`Page number too big, maximum page number is ${totalPages}`);
    }
    const requests = await this.db('rectification_requests')
      .select('id')
      .select('request_reason')
      .select('rectification_requests.created_at')
      .select('rectification_requests.status')
      .whereNot('status', RECTIFICATION_STATUSES.PENDING)
      .leftJoin('subject_keys', 'rectification_requests.subject_id', 'subject_keys.subject_id')
      .limit(PAGE_SIZE)
      .offset((requestedPage - 1) * PAGE_SIZE);

    return {
      data: requests,
      paging: {
        current: requestedPage,
        total: totalPages
      }
    };
  }

  async getRequestData(id) {
    const [requestData] = await this.db('rectification_requests')
      .select(
        'key',
        'personal_data',
        'status',
        'encrypted_rectification_payload',
        'rectification_requests.subject_id'
      )
      .select(this.db.raw('rectification_requests.id as rectification_request_id'))
      .select(this.db.raw('rectification_requests.created_at as rectification_request_created_at'))
      .join('subjects', 'rectification_requests.subject_id', 'subjects.id')
      .leftJoin('subject_keys', 'subject_keys.subject_id', 'subjects.id')
      .where({ 'rectification_requests.id': id });
    return requestData;
  }

  async updateRectificationRequestStatus(requestId, status) {
    const [request] = await this.db('rectification_requests').where({ id: requestId });
    if (!request) throw new NotFound('Rectification request not found');
    if (status === request.status) throw new BadRequest(`Status is already ${status}`);
    let requestData;
    await this.db.transaction(async trx => {
      // if the status is becoming approved -> apply the update to the users data
      if (status === RECTIFICATION_STATUSES.APPROVED) {
        requestData = await this.getRequestData(request.id);
        if (!requestData.key) throw new BadRequest('Decryption key not found');
        const decryptedUpdatePayload = JSON.parse(
          decryptFromStorage(requestData.encrypted_rectification_payload, requestData.key)
        );
        const decryptedCurrentData = JSON.parse(
          decryptFromStorage(requestData.personal_data, requestData.key)
        );
        const newData = Object.assign({}, decryptedCurrentData, decryptedUpdatePayload);
        await this.db('subjects')
          .transacting(trx)
          .update({ personal_data: encryptForStorage(JSON.stringify(newData), requestData.key) })
          .where({ id: requestData.subject_id });
      }
      await this.db('rectification_requests')
        .transacting(trx)
        .where({ id: requestId })
        .update({ status });

      await trx.commit();
    });
    if (status === RECTIFICATION_STATUSES.APPROVED) {
      await recordRectificationByController(requestData.subject_id);
    }
    return { success: true };
  }

  async getRectificationRequest(requestId) {
    const requestData = await this.getRequestData(requestId);
    if (!requestData) throw new NotFound('Request not found');
    if (!requestData.key) throw new BadRequest('Decryption key not found');
    const decryptedUpdatePayload = JSON.parse(
      decryptFromStorage(requestData.encrypted_rectification_payload, requestData.key)
    );
    const decryptedCurrentData = JSON.parse(
      decryptFromStorage(requestData.personal_data, requestData.key)
    );
    return {
      id: requestData.rectification_request_id,
      currentData: decryptedCurrentData,
      updates: decryptedUpdatePayload,
      createdAt: requestData.rectification_request_created_at,
      status: requestData.status
    };
  }
}

module.exports = SubjectsService;
