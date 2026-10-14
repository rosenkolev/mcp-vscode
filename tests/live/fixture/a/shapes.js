'use strict';

class Shape {
  /**
   * Scales the shape.
   * @param {number} factor how much bigger
   * @param {string} unit unit of the result
   */
  scale(factor, unit) {
    return `${factor}${unit}`;
  }
}

class Square extends Shape {
  constructor(side) {
    super();
    this.side = side;
  }
}

const square = new Square(2);
square.scale(3, 'px');

module.exports = { Shape, Square };
