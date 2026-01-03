class BaseRepository {
    constructor(model) {
        this.model = model;
    }

    async create(data) {
        return await this.model.create(data);
    }

    async findById(id, populate = []) {
        let query = this.model.findById(id);
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        return await query.exec();
    }

    async findOne(filter, populate = []) {
        let query = this.model.findOne(filter);
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        return await query.exec();
    }

    async findAll(filter = {}, sort = { createdAt: -1 }, populate = []) {
        let query = this.model.find(filter).sort(sort);
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        return await query.exec();
    }

    async update(id, data, populate = []) {
        let query = this.model.findByIdAndUpdate(id, data, { new: true, runValidators: true });
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        return await query.exec();
    }

    async delete(id) {
        return await this.model.findByIdAndDelete(id);
    }

    async count(filter = {}) {
        return await this.model.countDocuments(filter);
    }
}

module.exports = BaseRepository;
