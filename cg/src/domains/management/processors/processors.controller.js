const ProcessorsService = require('./processors.service');

class ProcessorsController {
  constructor(processorsService = null) {
    this.processorsService = processorsService || new ProcessorsService();
  }

  async listProcessors(req, res) {
    res.json(await this.processorsService.listProcessors());
  }

  async updateProcessor(req, res) {
    await this.processorsService.updateProcessor(req.body);
    res.send({ success: true });
  }

  async addProcessor(req, res) {
    await this.processorsService.addProcessor(req.body);
    res.send({ success: true });
  }

  async removeProcessors(req, res) {
    await this.processorsService.removeProcessors(req.body.processorIds);
    res.send({ success: true });
  }
}

module.exports = ProcessorsController;
