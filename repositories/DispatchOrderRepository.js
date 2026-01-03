const BaseRepository = require('./BaseRepository');
const DispatchOrder = require('../models/DispatchOrder');

class DispatchOrderRepository extends BaseRepository {
    constructor() {
        super(DispatchOrder);
    }

    // Add specific query methods for DispatchOrder here
    async findBySupplier(supplierId) {
        return await this.findAll({ supplier: supplierId });
    }

    async findPaginated(query, page = 1, limit = 20, populate = [], sort = { createdAt: -1 }) {
        const skip = (page - 1) * limit;

        // Ensure limit is a number
        const limitNum = parseInt(limit, 10);
        const pageNum = parseInt(page, 10);

        let dbQuery = this.model.find(query).sort(sort).skip(skip).limit(limitNum);

        if (populate.length > 0) {
            dbQuery = dbQuery.populate(populate);
        }

        const docs = await dbQuery.lean().exec();
        const total = await this.model.countDocuments(query);

        return {
            docs,
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(total / limitNum)
        };
    }
}

module.exports = new DispatchOrderRepository();
