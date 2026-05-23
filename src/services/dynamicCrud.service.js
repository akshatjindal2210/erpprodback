import dbQuery from "../config/db.js";
import { buildWhereClauses } from "../utils/dynamicQueryBuilder.js";
import { parseFilters, parsePagination, parseSort } from "../utils/requestQueryParser.js";

export const createDynamicCrudService = ({
  tableName,
  idField = "id",
  selectFields = ["*"],
  allowedFilterFields = [],
  allowedSearchFields = [],
  allowedSortFields = [],
  defaultSortBy = "id",
  softDelete = false
}) => {
  const allowedFields = [...new Set([...allowedFilterFields, ...allowedSearchFields, idField])];
  const selectClause = selectFields.join(", ");

  const buildQueryPayload = (payload = {}, baseFilters = []) => {
    const mergedFilters = [...baseFilters, ...parseFilters(payload.filters)];

    return buildWhereClauses({
      filters: mergedFilters,
      search: payload.search,
      searchableFields: allowedSearchFields,
      allowedFields,
      advancedSearch: payload.advancedSearch
    });
  };

  const list = async (payload = {}) => {
    const { page, limit, offset } = parsePagination(payload);
    const { sortBy, order } = parseSort(payload, {
      defaultSortBy,
      allowedSortFields: allowedSortFields.length ? allowedSortFields : allowedFields
    });

    const baseFilters = softDelete ? [{ field: "is_deleted", operator: "eq", value: false }] : [];
    
    // Permission-based date restriction (can_view_days)
    if (payload.permission?.can_view_days > 0) {
      baseFilters.push({ 
        field: "created_at", 
        operator: "gte", 
        value: `CURRENT_DATE - INTERVAL '${payload.permission.can_view_days - 1} days'`,
        isRaw: true // We'll need to handle this in dynamicQueryBuilder
      });
    }

    const { values, whereClause } = buildQueryPayload(payload, baseFilters);

    const countQuery = `SELECT COUNT(*) AS count FROM ${tableName} ${whereClause}`;
    const countRows = await dbQuery(countQuery, values);
    const total = Number.parseInt(countRows[0]?.count ?? 0, 10);

    const dataValues = [...values, limit, offset];
    const rows = await dbQuery(
      `SELECT ${selectClause}
       FROM ${tableName}
       ${whereClause}
       ORDER BY ${sortBy} ${order}
       LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
      dataValues
    );

    return {
      data: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  };

  const update = async (payload = {}, meta = {}) => {
    const data = payload.data ?? {};
    const dataEntries = Object.entries(data);

    if (!dataEntries.length) throw new Error("No fields to update");

    const allowedUpdateFields = allowedFields.filter((field) => field !== idField && field !== "is_deleted");
    const validEntries = dataEntries.filter(([field]) => allowedUpdateFields.includes(field));
    if (!validEntries.length) throw new Error("No valid fields to update");

    const filters = [...parseFilters(payload.filters)];
    if (payload.id !== undefined) {
      filters.push({ field: idField, operator: "eq", value: payload.id });
    }
    if (softDelete) {
      filters.push({ field: "is_deleted", operator: "eq", value: false });
    }

    if (!filters.length && !payload.advancedSearch?.conditions?.length) {
      throw new Error("Provide id, filters or advancedSearch for update");
    }

    const basePayload = {
      filters,
      advancedSearch: payload.advancedSearch
    };

    const { values, whereClause } = buildQueryPayload(basePayload);
    if (!whereClause) throw new Error("Update condition is required");

    const setValues = [];
    const setClauses = validEntries.map(([field, value], index) => {
      setValues.push(value);
      return `${field} = $${index + 1}`;
    });

    if (meta.updated_by !== undefined && allowedUpdateFields.includes("updated_by")) {
      setValues.push(meta.updated_by);
      setClauses.push(`updated_by = $${setValues.length}`);
    }
    if (allowedUpdateFields.includes("updated_at")) {
      setClauses.push("updated_at = NOW()");
    }

    const shiftedWhereClause = whereClause.replace(/\$(\d+)/g, (_, idx) => `$${Number(idx) + setValues.length}`);
    const finalValues = [...setValues, ...values];

    return dbQuery(
      `UPDATE ${tableName}
       SET ${setClauses.join(", ")}
       ${shiftedWhereClause}
       RETURNING ${selectClause}`,
      finalValues
    );
  };

  const remove = async (payload = {}, meta = {}) => {
    const filters = [...parseFilters(payload.filters)];
    if (payload.id !== undefined) {
      filters.push({ field: idField, operator: "eq", value: payload.id });
    }
    if (softDelete) {
      filters.push({ field: "is_deleted", operator: "eq", value: false });
    }

    if (!filters.length && !payload.advancedSearch?.conditions?.length) {
      throw new Error("Provide id, filters or advancedSearch for delete");
    }

    const { values, whereClause } = buildQueryPayload({
      filters,
      advancedSearch: payload.advancedSearch
    });

    if (!whereClause) throw new Error("Delete condition is required");

    if (softDelete) {
      const extraSet = [];
      const updateValues = [...values];

      if (allowedFields.includes("deleted_by")) {
        updateValues.push(meta.deleted_by ?? null);
        extraSet.push(`deleted_by = $${updateValues.length}`);
      }
      if (allowedFields.includes("deleted_at")) {
        extraSet.push("deleted_at = NOW()");
      }

      return dbQuery(
        `UPDATE ${tableName}
         SET is_deleted = true${extraSet.length ? `, ${extraSet.join(", ")}` : ""}
         ${whereClause}
         RETURNING ${selectClause}`,
        updateValues
      );
    }

    return dbQuery(
      `DELETE FROM ${tableName}
       ${whereClause}
       RETURNING ${selectClause}`,
      values
    );
  };

  return { list, update, remove };
};
