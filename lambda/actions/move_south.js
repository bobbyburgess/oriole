const { handleMove } = require('./move_handler');

exports.handler = async (event) => {
  return handleMove('south', event);
};
