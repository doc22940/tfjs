/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Use of this source code is governed by an MIT-style
 * license that can be found in the LICENSE file or at
 * https://opensource.org/licenses/MIT.
 * =============================================================================
 */

/**
 * Layers that augment the functionality of a base layer.
 */

import * as tfc from '@tensorflow/tfjs-core';
import {serialization, Tensor, tidy} from '@tensorflow/tfjs-core';

import {getScalar} from '../backend/state';
import * as K from '../backend/tfjs_backend';
import {nameScope} from '../common';
import {InputSpec, Layer, LayerConfig, SymbolicTensor} from '../engine/topology';
import {NotImplementedError, ValueError} from '../errors';
import {Kwargs, Shape} from '../types';
import {RegularizerFn, RnnStepFunction} from '../types';
import * as generic_utils from '../utils/generic_utils';
import {getExactlyOneShape, getExactlyOneTensor} from '../utils/types_utils';
import {LayerVariable} from '../variables';

import {rnn, RNN, standardizeArgs} from './recurrent';
import {deserialize} from './serialization';


export interface WrapperLayerConfig extends LayerConfig {
  /**
   * The layer to be wrapped.
   */
  layer: Layer;
}

/**
 * Abstract wrapper base class.
 *
 * Wrappers take another layer and augment it in various ways.
 * Do not use this class as a layer, it is only an abstract base class.
 * Two usable wrappers are the `TimeDistributed` and `Bidirectional` wrappers.
 */
export abstract class Wrapper extends Layer {
  readonly layer: Layer;

  constructor(config: WrapperLayerConfig) {
    // Porting Note: In PyKeras, `self.layer` is set prior to the calling
    //   `super()`. But we can't do that here due to TypeScript's restriction.
    //   See: https://github.com/Microsoft/TypeScript/issues/8277
    //   As a result, we have to add checks in `get trainable()` and
    //   `set trainable()` below in order to prevent using `this.layer` when
    //   its value is `undefined`. The super constructor does use the getter
    //   and the setter of `this.layer`.
    super(config);
    this.layer = config.layer;
  }

  build(inputShape: Shape|Shape[]): void {
    this.built = true;
  }

  // TODO(cais): Implement activityRegularizer getter.

  get trainable(): boolean {
    // Porting Note: the check of `this.layer` here is necessary due to the
    //   way the `constructor` of this class is written (see Porting Note
    //   above).
    if (this.layer != null) {
      return this.layer.trainable;
    } else {
      return false;
    }
  }

  set trainable(value: boolean) {
    // Porting Note: the check of `this.layer` here is necessary due to the
    //   way the `constructor` of this class is written (see Porting Note
    //   above).
    if (this.layer != null) {
      this.layer.trainable = value;
    }
  }

  get trainableWeights(): LayerVariable[] {
    return this.layer.trainableWeights;
  }
  // TODO(cais): Implement setter for trainableWeights.

  get nonTrainableWeights(): LayerVariable[] {
    return this.layer.nonTrainableWeights;
  }
  // TODO(cais): Implement setter for nonTrainableWeights.

  get updates(): Tensor[] {
    // tslint:disable-next-line:no-any
    return (this.layer as any)._updates;
  }

  // TODO(cais): Implement getUpdatesFor().

  get losses(): RegularizerFn[] {
    return this.layer.losses;
  }

  // TODO(cais): Implement getLossesFor().

  getWeights(): Tensor[] {
    return this.layer.getWeights();
  }

  setWeights(weights: Tensor[]): void {
    this.layer.setWeights(weights);
  }

  getConfig(): serialization.ConfigDict {
    const config: serialization.ConfigDict = {
      'layer': {
        'className': this.layer.getClassName(),
        'config': this.layer.getConfig(),
      }
    };
    const baseConfig = super.getConfig();
    Object.assign(config, baseConfig);
    return config;
  }

  static fromConfig<T extends serialization.Serializable>(
      cls: serialization.SerializableConstructor<T>,
      config: serialization.ConfigDict,
      customObjects = {} as serialization.ConfigDict): T {
    const layerConfig = config['layer'] as serialization.ConfigDict;
    const layer = deserialize(layerConfig, customObjects) as Layer;
    delete config['layer'];
    const newConfig = {layer};
    Object.assign(newConfig, config);
    return new cls(newConfig);
  }
}

/**
 * This wrapper applies a layer to every temporal slice of an input.
 *
 * The input should be at least 3D,  and the dimension of the index `1` will be
 * considered to be the temporal dimension.
 *
 * Consider a batch of 32 samples, where each sample is a sequence of 10 vectors
 * of 16 dimensions. The batch input shape of the layer is then `[32,  10,
 * 16]`, and the `inputShape`, not including the sample dimension, is
 * `[10, 16]`.
 *
 * You can then use `TimeDistributed` to apply a `Dense` layer to each of the 10
 * timesteps, independently:
 *
 * ```js
 * const model = tf.sequential();
 * model.add(tf.layers.timeDistributed({
 *   layer: tf.layers.dense({units: 8}),
 *   inputShape: [10, 16],
 * }));
 *
 * // Now model.outputShape = [null, 10, 8].
 * // The output will then have shape `[32, 10, 8]`.
 *
 * // In subsequent layers, there is no need for `inputShape`:
 * model.add(tf.layers.timeDistributed({layer: tf.layers.dense({units: 32})}));
 * console.log(JSON.stringify(model.outputs[0].shape));
 * // Now model.outputShape = [null, 10, 32].
 * ```
 *
 * The output will then have shape `[32, 10, 32]`.
 *
 * `TimeDistributed` can be used with arbitrary layers, not just `Dense`, for
 * instance a `Conv2D` layer.
 *
 * ```js
 * const model = tf.sequential();
 * model.add(tf.layers.timeDistributed({
 *   layer: tf.layers.conv2d({filters: 64, kernelSize: [3, 3]}),
 *   inputShape: [10, 299, 299, 3],
 * }));
 * console.log(JSON.stringify(model.outputs[0].shape));
 * ```
 */
export class TimeDistributed extends Wrapper {
  static className = 'TimeDistributed';
  constructor(config: WrapperLayerConfig) {
    super(config);
    this.supportsMasking = true;
  }

  build(inputShape: Shape|Shape[]): void {
    inputShape = getExactlyOneShape(inputShape);
    if (inputShape.length < 3) {
      throw new ValueError(
          `TimeDistributed layer expects an input shape >= 3D, but received ` +
          `input shape ${JSON.stringify(inputShape)}`);
    }
    this.inputSpec = [{shape: inputShape}];
    const childInputShape = [inputShape[0]].concat(inputShape.slice(2));
    if (!this.layer.built) {
      this.layer.build(childInputShape);
      this.layer.built = true;
    }
    super.build(inputShape);
  }

  computeOutputShape(inputShape: Shape|Shape[]): Shape|Shape[] {
    inputShape = getExactlyOneShape(inputShape);
    const childInputShape = [inputShape[0]].concat(inputShape.slice(2));
    const childOutputShape =
        this.layer.computeOutputShape(childInputShape) as Shape;
    const timesteps = inputShape[1];
    return [childOutputShape[0], timesteps].concat(childOutputShape.slice(1));
  }

  call(inputs: Tensor|Tensor[], kwargs: Kwargs): Tensor|Tensor[] {
    return tidy(() => {
      // TODO(cais): Add 'training' and 'useLearningPhase' to kwargs.
      inputs = getExactlyOneTensor(inputs);
      // Porting Note: In tfjs-layers, `inputs` are always concrete tensor
      // values. Hence the inputs can't have an undetermined first (batch)
      // dimension, which is why we always use the K.rnn approach here.
      const step: RnnStepFunction = (inputs: Tensor, states: Tensor[]) => {
        // TODO(cais): Add useLearningPhase.
        const output = this.layer.call(inputs, kwargs) as Tensor;
        return [output, []];
      };
      const rnnOutputs =
          rnn(step, inputs, [], false, null, null, false, inputs.shape[1]);
      const y = rnnOutputs[1];
      // TODO(cais): Add activity regularization.
      // TODO(cais): Add useLearningPhase.
      return y;
    });
  }
}
serialization.registerClass(TimeDistributed);

export type BidirectionalMergeMode = 'sum'|'mul'|'concat'|'ave';
export const VALID_BIDIRECTIONAL_MERGE_MODES = ['sum', 'mul', 'concat', 'ave'];
export function checkBidirectionalMergeMode(value?: string): void {
  generic_utils.checkStringTypeUnionValue(
      VALID_BIDIRECTIONAL_MERGE_MODES, 'BidirectionalMergeMode', value);
}

export interface BidirectionalLayerConfig extends WrapperLayerConfig {
  /**
   * The instance of an `RNN` layer to be wrapped.
   */
  layer: RNN;

  /**
   * Mode by which outputs of the forward and backward RNNs are combinied.
   * If `null` or `undefined`, the output will not be combined, they will be
   * returned as an `Array`.
   */
  mergeMode?: BidirectionalMergeMode;
}

export class Bidirectional extends Wrapper {
  static className = 'Bidirectional';
  private forwardLayer: RNN;
  private backwardLayer: RNN;
  private mergeMode: BidirectionalMergeMode;
  private returnSequences: boolean;
  private returnState: boolean;
  private numConstants?: number;
  private _trainable: boolean;

  constructor(config: BidirectionalLayerConfig) {
    super(config);

    // Note: When creating `this.forwardLayer`, the original Layer object
    //   (`config.layer`) ought to be cloned. This is why we call `getConfig()`
    //   followed by `deserialize()`. Without this cloning, the layer names
    //   saved during serialization will incorrectly contain the 'forward_'
    //   prefix.
    //   In Python Keras, this is done using `copy.copy` (shallow copy), which
    //   does not have a simple equivalent in JavaScript. JavaScript's
    //   `Object.assign()` does not copy methods.
    const layerConfig = config.layer.getConfig();
    this.forwardLayer =
        deserialize(
            {className: config.layer.getClassName(), config: layerConfig}) as
        RNN;
    layerConfig['goBackwards'] =
        layerConfig['goBackwards'] === true ? false : true;
    this.backwardLayer =
        deserialize(
            {className: config.layer.getClassName(), config: layerConfig}) as
        RNN;
    this.forwardLayer.name = 'forward_' + this.forwardLayer.name;
    this.backwardLayer.name = 'backward_' + this.backwardLayer.name;
    checkBidirectionalMergeMode(config.mergeMode);
    this.mergeMode = config.mergeMode;
    if (config.weights) {
      throw new NotImplementedError(
          'weights support is not implemented for Bidirectional layer yet.');
    }
    this._stateful = config.layer.stateful;
    this.returnSequences = config.layer.returnSequences;
    this.returnState = config.layer.returnState;
    this.supportsMasking = true;
    this._trainable = true;
    this.inputSpec = config.layer.inputSpec;
    this.numConstants = null;
  }

  get trainable(): boolean {
    return this._trainable;
  }

  set trainable(value: boolean) {
    // Porting Note: the check of `this.layer` here is necessary due to the
    //   way the `constructor` of this class is written (see Porting Note
    //   above).
    this._trainable = value;
    if (this.forwardLayer != null) {
      this.forwardLayer.trainable = value;
    }
    if (this.backwardLayer != null) {
      this.backwardLayer.trainable = value;
    }
  }

  getWeights(): Tensor[] {
    return this.forwardLayer.getWeights().concat(
        this.backwardLayer.getWeights());
  }

  setWeights(weights: Tensor[]): void {
    const numWeights = weights.length;
    const numeightsOver2 = Math.floor(numWeights / 2);
    this.forwardLayer.setWeights(weights.slice(0, numeightsOver2));
    this.backwardLayer.setWeights(weights.slice(numeightsOver2));
  }

  computeOutputShape(inputShape: Shape|Shape[]): Shape|Shape[] {
    let layerShapes: Shape|Shape[] =
        this.forwardLayer.computeOutputShape(inputShape);
    if (!(Array.isArray(layerShapes) && Array.isArray(layerShapes[0]))) {
      layerShapes = [layerShapes as Shape];
    }
    layerShapes = layerShapes as Shape[];

    let outputShape: Shape;
    let outputShapes: Shape[];
    let stateShape: Shape[];
    if (this.returnState) {
      stateShape = layerShapes.slice(1);
      outputShape = layerShapes[0];
    } else {
      outputShape = layerShapes[0];
    }
    outputShape = outputShape as Shape;
    if (this.mergeMode === 'concat') {
      outputShape[outputShape.length - 1] *= 2;
      outputShapes = [outputShape];
    } else if (this.mergeMode == null) {
      outputShapes = [outputShape, outputShape.slice()];
    } else {
      outputShapes = [outputShape];
    }

    if (this.returnState) {
      if (this.mergeMode == null) {
        return outputShapes.concat(stateShape).concat(stateShape.slice());
      }
      return [outputShape].concat(stateShape).concat(stateShape.slice());
    }
    return generic_utils.singletonOrArray(outputShapes);
  }

  apply(
      inputs: Tensor|Tensor[]|SymbolicTensor|SymbolicTensor[],
      kwargs?: Kwargs): Tensor|Tensor[]|SymbolicTensor|SymbolicTensor[] {
    let initialState: Tensor[]|SymbolicTensor[] =
        kwargs == null ? null : kwargs['initialState'];
    let constants: Tensor[]|SymbolicTensor[] =
        kwargs == null ? null : kwargs['constants'];
    if (kwargs == null) {
      kwargs = {};
    }
    const standardized =
        standardizeArgs(inputs, initialState, constants, this.numConstants);
    inputs = standardized.inputs as Tensor | SymbolicTensor;
    initialState = standardized.initialState;
    constants = standardized.constants;

    if (Array.isArray(inputs)) {
      initialState = (inputs as Tensor[] | SymbolicTensor[]).slice(1);
      inputs = (inputs as Tensor[] | SymbolicTensor[])[0];
    }

    if ((initialState == null || initialState.length === 0) &&
        constants == null) {
      return super.apply(inputs, kwargs);
    }
    const additionalInputs: Array<Tensor|SymbolicTensor> = [];
    const additionalSpecs: InputSpec[] = [];
    if (initialState != null) {
      const numStates = initialState.length;
      if (numStates % 2 > 0) {
        throw new ValueError(
            'When passing `initialState` to a Bidrectional RNN, ' +
            'the state should be an Array containing the states of ' +
            'the underlying RNNs.');
      }
      kwargs['initialState'] = initialState;
      additionalInputs.push(...initialState);
      const stateSpecs = (initialState as Array<Tensor|SymbolicTensor>)
                             .map(state => new InputSpec({shape: state.shape}));
      this.forwardLayer.stateSpec = stateSpecs.slice(0, numStates / 2);
      this.backwardLayer.stateSpec = stateSpecs.slice(numStates / 2);
      additionalSpecs.push(...stateSpecs);
    }
    if (constants != null) {
      throw new NotImplementedError(
          'Support for constants in Bidirectional layers is not ' +
          'implemented yet.');
    }

    const isSymbolicTensor = additionalInputs[0] instanceof SymbolicTensor;
    for (const tensor of additionalInputs) {
      if (tensor instanceof SymbolicTensor !== isSymbolicTensor) {
        throw new ValueError(
            'The initial state of a Bidirectional layer cannot be ' +
            'specified as a mix of symbolic and non-symbolic tensors');
      }
    }

    if (isSymbolicTensor) {
      // Compute the full input and specs, including the states.
      const fullInput = [inputs].concat(additionalInputs);
      const fullInputSpec = this.inputSpec.concat(additionalSpecs);
      // Perform the call temporarily and replace inputSpec.
      // Note: with initial states symbolic calls and non-symbolic calls to this
      // method differ in how the initial states are passed. For symbolic calls,
      // the initial states are passed in the first arg, as an Array of
      // SymbolicTensors; for non-symbolic calls, they are passed in the second
      // arg as a part of the kwargs. Hence the need to temporarily modify
      // inputSpec here.
      // TODO(cais): Make refactoring so that this hacky code below is no
      // longer needed.
      const originalInputSpec = this.inputSpec;
      this.inputSpec = fullInputSpec;
      const output =
          super.apply(fullInput as Tensor[] | SymbolicTensor[], kwargs);
      this.inputSpec = originalInputSpec;
      return output;
    } else {
      return super.apply(inputs, kwargs);
    }
  }

  call(inputs: Tensor|Tensor[], kwargs: Kwargs): Tensor|Tensor[] {
    return tidy(() => {
      if (kwargs['mask'] != null) {
        throw new NotImplementedError(
            'The support for masking is not implemented for ' +
            'Bidirectional layers yet.');
      }
      const initialState = kwargs['initialState'];

      let y: Tensor|Tensor[];
      let yRev: Tensor|Tensor[];
      if (initialState == null) {
        y = this.forwardLayer.call(inputs, kwargs);
        yRev = this.backwardLayer.call(inputs, kwargs);
      } else {
        const forwardState = initialState.slice(0, initialState.length / 2);
        const backwardState = initialState.slice(initialState.length / 2);
        y = this.forwardLayer.call(
            inputs, Object.assign(kwargs, {initialState: forwardState}));
        yRev = this.forwardLayer.call(
            inputs, Object.assign(kwargs, {initialState: backwardState}));
      }

      let states: Tensor[];
      if (this.returnState) {
        if (Array.isArray(y)) {
          states = (y as Tensor[]).slice(1).concat((yRev as Tensor[]).slice(1));
        } else {
        }
        y = (y as Tensor[])[0];
        yRev = (yRev as Tensor[])[0];
      }

      if (this.returnSequences) {
        yRev = tfc.reverse(yRev as Tensor, 1);
      }

      let output: Tensor|Tensor[];
      if (this.mergeMode === 'concat') {
        output = K.concatenate([y as Tensor, yRev as Tensor]);
      } else if (this.mergeMode === 'sum') {
        output = tfc.add(y as Tensor, yRev as Tensor);
      } else if (this.mergeMode === 'ave') {
        output = tfc.mul(getScalar(0.5), tfc.add(y as Tensor, yRev as Tensor));
      } else if (this.mergeMode === 'mul') {
        output = tfc.mul(y as Tensor, yRev as Tensor);
      } else if (this.mergeMode == null) {
        output = [y as Tensor, yRev as Tensor];
      }

      // TODO(cais): Properly set learning phase.
      if (this.returnState) {
        if (this.mergeMode == null) {
          return (output as Tensor[]).concat(states);
        }
        return [output as Tensor].concat(states);
      }
      return output;
    });
  }

  resetStates(states?: Tensor|Tensor[]): void {
    this.forwardLayer.resetStates();
    this.backwardLayer.resetStates();
  }

  build(inputShape: Shape|Shape[]): void {
    nameScope(this.forwardLayer.name, () => {
      this.forwardLayer.build(inputShape);
    });
    nameScope(this.backwardLayer.name, () => {
      this.backwardLayer.build(inputShape);
    });
    this.built = true;
  }

  // TODO(cais): Implement computeMask().

  get trainableWeights(): LayerVariable[] {
    return this.forwardLayer.trainableWeights.concat(
        this.backwardLayer.trainableWeights);
  }

  get nonTrainableWeights(): LayerVariable[] {
    return this.forwardLayer.nonTrainableWeights.concat(
        this.backwardLayer.nonTrainableWeights);
  }

  // TODO(cais): Implement constraints().

  getConfig(): serialization.ConfigDict {
    const config: serialization.ConfigDict = {
      'mergeMode': this.mergeMode,
    };
    // TODO(cais): Add logic for `numConstants` once the property is added.
    const baseConfig = super.getConfig();
    Object.assign(config, baseConfig);
    return config;
  }

  static fromConfig<T extends serialization.Serializable>(
      cls: serialization.SerializableConstructor<T>,
      config: serialization.ConfigDict): T {
    const rnnLayer =
        deserialize(config['layer'] as serialization.ConfigDict) as RNN;
    delete config['layer'];
    // TODO(cais): Add logic for `numConstants` once the property is added.
    if (config['numConstants'] != null) {
      throw new NotImplementedError(
          `Deserialization of a Bidirectional layer with numConstants ` +
          `present is not supported yet.`);
    }
    // tslint:disable-next-line:no-any
    const newConfig: {[key: string]: any} = config;
    newConfig['layer'] = rnnLayer;
    return new cls(newConfig);
  }
}
serialization.registerClass(Bidirectional);