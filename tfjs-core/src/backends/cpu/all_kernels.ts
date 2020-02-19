/**
 * @license
 * Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

// We explicitly import the modular kernels so they get registered in the
// global registry when we compile the library. A modular build would replace
// the contents of this file and import only the kernels that are needed.
import './square';
import './non_max_suppression_v5';

// TODO import from tensorflow/tfjs-core once core stops importing this file.
import {KernelConfig} from '../../kernel_registry';

// Import Kernel Configs here.
import {squaredDifference_} from './kernels/SquaredDifference';

// Export all kernel configs here so that the package can auto register them
export const kernelConfigs: KernelConfig[] = [
  squaredDifference_,
];
