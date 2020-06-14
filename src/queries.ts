/**
 * Implementation of model queries for mongo
 */

import * as _ from 'lodash';
import { populateDocs } from './populate';
import { getDocRef, getModel } from './utils/get-doc-ref';
import { convertRestQueryParams } from 'strapi-utils';
import { StrapiQueryParams, StrapiFilter, StrapiWhereFilter } from './types';
import { StatusError } from './utils/status-error';
import { deleteRelations, updateRelations } from './relations';
import { WhereFilterOp, DocumentData, Transaction, Query, DocumentSnapshot, FieldValue } from '@google-cloud/firestore';
import { validateComponents } from './utils/validate-components';
import { ManualFilter, manualQuery } from './utils/manual-query';



export function queries({ model, modelKey, strapi }: StrapiQueryParams) {
  const assocKeys = model.associations.map(ast => ast.alias);
  const componentKeys = Object.keys(model.attributes).filter(key =>
    ['component', 'dynamiczone'].includes(model.attributes[key].type)
  );
  const metaKeys = ['id', model.primaryKey];

  const excludedKeys = assocKeys.concat(metaKeys);

  const defaultPopulate = model.associations
    .filter(ast => ast.autoPopulate !== false)
    .map(ast => ast.alias);
  

  const hasPK = (obj: any) => _.has(obj, model.primaryKey) || _.has(obj, 'id');
  const getPK = (obj: any) => (_.has(obj, model.primaryKey) ? obj[model.primaryKey] : obj.id);

  const pickRelations = values => {
    return _.pick(values, assocKeys);
  };

  const omitExernalValues = values => {
    return _.omit(values, excludedKeys);
  };


  function manualWhere(field: string, predicate: (fieldValue: any) => boolean) {
    return (docData: DocumentData) => {
      const value = _.get(docData, field, undefined);
      return predicate(value);
    };
  }
  

  function convertWhere({ field, value, operator }: StrapiWhereFilter) {
    
    const details = model._attributes[field];
    const assocModel = getModel(details.model || details.collection, details.plugin);

    if (assocModel) {
      // Convert reference ID to document reference
      value = getDocRef(value, assocModel);
    }

    let op: WhereFilterOp | ((data: DocumentData) => boolean);
    switch (operator) {
      case 'eq':
        op = '==';
        break;
      case 'ne':
        op = manualWhere(field, (val) => val != value);
        break;
      case 'in':
        op = 'in';
        break;
      case 'nin':
        op = manualWhere(field, (val) => !_.includes(val, value));
        break;
      case 'contains':
        op = manualWhere(field, (val) => _.includes(val, value));
        break;
      case 'ncontains':
        op = manualWhere(field, (val) => !_.includes(val, value));
        break;
      case 'containss':
        op = manualWhere(field, (val) => _.includes(_.toLower(val), _.toLower(value)));
        break;
      case 'ncontainss':
        op = manualWhere(field, (val) => !_.includes(_.toLower(val), _.toLower(value)));
        break;
      case 'lt':
        op = '<';
        break;
      case 'lte':
        op = '<=';
        break;
      case 'gt':
        op = '>';
        break;
      case 'gte':
        op = '>=';
        break;
      case 'null':
        if (value) {
          op = '==';
          value = null;
        } else {
          op = manualWhere(field, (val) => val != null);
        }
        break;
    }

    return {
      field,
      operator: op,
      value
    };
  }

  function buildSearchQuery(value: any) {
    let query: Query = model;
    const manualFilters: ManualFilter[] = [];
  
    Object.keys(model.attributes).forEach((field) => {
      switch (model.attributes[field].type) {
        case 'biginteger':
        case 'integer':
        case 'float':
        case 'decimal':
          const number = _.toNumber(value);
          if (!_.isNaN(number)) {
            query = query.where(field, '==', number);
          }
        case 'string':
        case 'text':
        case 'richtext':
        case 'email':
        case 'enumeration':
        case 'uid':
          const regex = new RegExp(value, 'i');
          manualFilters.push(manualWhere(field, (val) => regex.test(val)));
      }
    });
  
    return { query, manualFilters };
  };

  async function buildFirestoreQuery(params, searchQuery?: string, transaction?: Transaction) {
    // Remove any search query
    // because we extract and handle it separately
    delete params._q;

    const filters: StrapiFilter = convertRestQueryParams(params);
    let query: Query = model;
    let manualFilters: ManualFilter[] = [];

    if (searchQuery) {
      const q = buildSearchQuery(searchQuery);
      manualFilters = manualFilters.concat(q.manualFilters);
      query = q.query;
    } else {
      (filters.where || []).forEach((filter) => {
        const { field, operator, value } = convertWhere(filter);
        if (typeof operator === 'function') {
          manualFilters.push(operator);
        } else {
          query = query.where(field, operator, value);
        }
      });
    }
    

    (filters.sort || []).forEach(({ field, order }) => {
      if (_.includes(metaKeys, field)) {
        // Can't support sorting by document ID (it is not part
        // of the document's fields)
        // Sort fields also act as a filter so this would elminiate all results
        return;
      }
      query = query.orderBy(field, order);
    });

    if (filters.start && (filters.start > 0)) {
      query = query.offset(filters.start);
    }

    const limit = Math.max(0, filters.limit || 0);
    return await manualQuery(
      query, 
      manualFilters,
      searchQuery ? 'or' : 'and', 
      limit, 
      transaction
    );
  }


  async function find(params: any, populate?: string[]) {
    const populateOpt = populate || defaultPopulate;

    return await model.firestore.runTransaction(async trans => {
      let docs: DocumentSnapshot[];
      if (hasPK(params)) {
        const ref = model.doc(getPK(params));
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await buildFirestoreQuery(params, undefined, trans);
      }

      return await populateDocs(model, docs, populateOpt, trans);
    });
  }

  async function findOne(params: any, populate?: string[]) {
    const entries = await find({ ...params, _limit: 1 }, populate);
    return entries[0] || null;
  }

  async function count(params: any) {
    // Don't populate any fields, we are just counting
    const docs = await buildFirestoreQuery(params);
    return docs.length;
  }

  async function create(values: any) {

    // Validate components dynamiczone
    validateComponents(values, model, componentKeys);

    // Extract values related to relational data.
    const relations = pickRelations(values);
    let data = omitExernalValues(values);

    // Add timestamp data
    if (_.isArray(model.options.timestamps)) {
      const [createdAtKey, updatedAtKey] = model.options.timestamps;
      data[createdAtKey] = FieldValue.serverTimestamp();
      data[updatedAtKey] = FieldValue.serverTimestamp();
    }

    // Create entry without relational data.
    const id = getPK(values);
    const ref = id ? model.doc(id) : model.doc();

    return await model.firestore.runTransaction(async trans => {
      
      // Create relational data and return the entry.
      const [entry] = await populateDocs(model, [{ id: ref.id, ref, data: () => data }], defaultPopulate, trans);
      data = await updateRelations(model, {
        [model.primaryKey]: ref.id,
        values: relations,
        data,
        entry,
        ref
      }, trans);

      trans.create(ref, data);

      return entry;
    });
  }

  async function update(params: any, values: any) {

    // Validate components dynamiczone
    validateComponents(values, model, componentKeys);

    // Extract values related to relational data.
    const relations = pickRelations(values);
    let data = omitExernalValues(values);

    // Add timestamp data
    if (_.isArray(model.options.timestamps)) {
      const [createdAtKey, updatedAtKey] = model.options.timestamps;

      // Prevent creation timestamp from being overwritten
      delete data[createdAtKey];

      data[updatedAtKey] = FieldValue.serverTimestamp();
    }

    // Run the transaction
    return await model.firestore.runTransaction(async trans => {
      let snap: DocumentSnapshot | null;
      if (hasPK(params)) {
        const ref = model.doc(getPK(params));
        snap = await trans.get(ref);
        if (!snap.exists) {
          snap = null;
        }
      } else {
        const docs = await buildFirestoreQuery({ ...params, _limit: 1 }, undefined, trans);
        snap = docs[0] || null;
      }

      if (!snap) {
        throw new StatusError('entry.notFound', 404);
      }


      // Update relational data
      const [entry] = await populateDocs(model, [snap], defaultPopulate, trans);
      data = await updateRelations(model, {
        [model.primaryKey]: snap.id,
        values: relations,
        data,
        entry,
        ref: snap.ref
      }, trans);


      // Update entry without relational data.
      trans.set(snap.ref, data, { merge: true });

      return entry;

    });
  }

  async function deleteMany(params: any) {
    if (hasPK(params)) {
      return await deleteOne(getPK(params))
    } else {
      // FIXME: Running multiple deletes at the same time
      // Deletes may affect many relations
      // All are transacted so they all may interfere with eachother
      // Should run in the same transaction
      const entries = await find(params);
      return Promise.all(entries.map(entry => deleteOne(entry[model.primaryKey])));
    }
  }

  async function deleteOne(id: string) {
    
    return await model.firestore.runTransaction(async trans => {
      const ref = model.doc(id);
      const snap = await trans.get(ref);
      const entry = snap.data();
      if (!entry) {
        throw new StatusError('entry.notFound', 404);
      }

      const docs = await populateDocs(model, [snap], defaultPopulate, trans);

      await deleteRelations(model, { entry, ref }, trans);

      trans.delete(ref);

      return docs[0];
    });
  }

  async function search(params: any, populate?: string[]) {
    const populateOpt = populate || defaultPopulate;

    return await model.firestore.runTransaction(async trans => {
      let docs: DocumentSnapshot[];
      if (hasPK(params)) {
        const ref = model.doc(getPK(params));
        const snap = await trans.get(ref);
        if (!snap.exists) {
          docs = [];
        } else {
          docs = [snap];
        }
      } else {
        docs = await buildFirestoreQuery(params, params._q, trans);
      }

      return await populateDocs(model, docs, populateOpt, trans);
    });
  }

  async function countSearch(params: any) {
    // Don't populate any fields, we are just counting
    const docs = await buildFirestoreQuery(params, params._q);
    return docs.length;
  }

  return {
    findOne,
    find,
    create,
    update,
    delete: deleteMany,
    count,
    search,
    countSearch,
  };
};

