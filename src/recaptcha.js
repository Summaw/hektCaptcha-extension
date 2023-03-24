'use strict';

// Content script file will run in the context of web page.
// With content script you can manipulate the web pages using
// Document Object Model (DOM).
// You can also pass information to the parent extension.

// We execute this script by making an entry in manifest.json file
// under `content_scripts` property

// For more information on Content Scripts,
// See https://developer.chrome.com/extensions/content_scripts

const Jimp = require('jimp');
const ort = require('onnxruntime-web');

const extension_id = chrome.runtime.id;

// Modify ort wasm path
ort.env.wasm.wasmPaths = {
  'ort-wasm.wasm': `chrome-extension://${extension_id}/dist/ort-wasm.wasm`,
  'ort-wasm-threaded.wasm': `chrome-extension://${extension_id}/dist/ort-wasm-threaded.wasm`,
  'ort-wasm-simd.wasm': `chrome-extension://${extension_id}/dist/ort-wasm-simd.wasm`,
  'ort-wasm-simd-threaded.wasm': `chrome-extension://${extension_id}/dist/ort-wasm-simd-threaded.wasm`,
};

function imageDataToTensor(image, dims) {
  // 1. Get buffer data from image and extract R, G, and B arrays.
  var imageBufferData = image.bitmap.data;
  const [redArray, greenArray, blueArray] = [[], [], []];

  // 2. Loop through the image buffer and extract the R, G, and B channels
  for (let i = 0; i < imageBufferData.length; i += 4) {
    redArray.push(imageBufferData[i]);
    greenArray.push(imageBufferData[i + 1]);
    blueArray.push(imageBufferData[i + 2]);
  }

  // 3. Concatenate RGB to transpose [224, 224, 3] -> [3, 224, 224] to a number array
  const transposedData = redArray.concat(greenArray, blueArray);

  // 4. Convert to float32 and normalize to 1
  const float32Data = new Float32Array(transposedData.map((x) => x / 255.0));

  // 5. Normalize the data mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < float32Data.length; i++) {
    float32Data[i] = (float32Data[i] - mean[i % 3]) / std[i % 3];
  }

  // 6. Create a tensor from the float32 data
  const inputTensor = new ort.Tensor('float32', float32Data, dims);
  return inputTensor;
}

class Time {
  static time() {
    if (!Date.now) {
      Date.now = () => new Date().getTime();
    }
    return Date.now();
  }
  static sleep(i = 1000) {
    return new Promise((resolve) => setTimeout(resolve, i));
  }

  static async random_sleep(min, max) {
    const duration = Math.floor(Math.random() * (max - min) + min);
    return await Time.sleep(duration);
  }
}

(async () => {
  function is_widget_frame() {
    return document.querySelector('.recaptcha-checkbox') !== null;
  }

  function is_image_frame() {
    return document.querySelector('#rc-imageselect') !== null;
  }

  function open_image_frame() {
    document.querySelector('#recaptcha-anchor')?.click();
  }

  function is_invalid_config() {
    return document.querySelector('.rc-anchor-error-message') !== null;
  }

  function is_rate_limited() {
    return document.querySelector('.rc-doscaptcha-header') !== null;
  }

  function is_solved() {
    const is_widget_frame_solved =
      document
        .querySelector('.recaptcha-checkbox')
        ?.getAttribute('aria-checked') === 'true';
    // Note: verify button is disabled after clicking and during transition to the next image task
    const is_image_frame_solved = document.querySelector(
      '#recaptcha-verify-button'
    )?.disabled;
    return is_widget_frame_solved || is_image_frame_solved;
  }

  function on_images_ready(timeout = 15000) {
    return new Promise(async (resolve) => {
      const start = Time.time();
      while (true) {
        const $tiles = document.querySelectorAll('.rc-imageselect-tile');
        const $loading = document.querySelectorAll(
          '.rc-imageselect-dynamic-selected'
        );
        const is_loaded = $tiles.length > 0 && $loading.length === 0;
        if (is_loaded) {
          return resolve(true);
        }
        if (Time.time() - start > timeout) {
          return resolve(false);
        }
        await Time.sleep(100);
      }
    });
  }

  function get_image_url($e) {
    return $e?.src?.trim();
  }

  async function get_task(task_lines) {
    let task = null;
    if (task_lines.length > 1) {
      // task = task_lines[1];
      task = task_lines.slice(0, 2).join(' ');
      task = task.replace(/\s+/g, ' ')?.trim();
    } else {
      task = task.join('\n');
    }
    if (!task) {
      return null;
    }
    return task;
  }

  let last_urls_hash = null;
  function on_task_ready(i = 500) {
    return new Promise((resolve) => {
      let checking = false;
      const check_interval = setInterval(async () => {
        if (checking) {
          return;
        }
        checking = true;

        const task_lines = document
          .querySelector('.rc-imageselect-instructions')
          ?.innerText?.split('\n');
        let task = await get_task(task_lines);
        if (!task) {
          checking = false;
          return;
        }

        const is_hard = task_lines.length === 3 ? true : false;

        const $cells = document.querySelectorAll('table tr td');
        if ($cells.length !== 9 && $cells.length !== 16) {
          checking = false;
          return;
        }

        const cells = [];
        const urls = Array($cells.length).fill(null);
        let background_url = null;
        let has_secondary_images = false;
        let i = 0;
        for (const $e of $cells) {
          const $img = $e?.querySelector('img');
          if (!$img) {
            checking = false;
            return;
          }

          const url = get_image_url($img);
          if (!url || url === '') {
            checking = false;
            return;
          }

          if ($img.naturalWidth >= 300) {
            background_url = url;
          } else if ($img.naturalWidth == 100) {
            urls[i] = url;
            has_secondary_images = true;
          }

          cells.push($e);
          i++;
        }
        if (has_secondary_images) {
          background_url = null;
        }

        const urls_hash = JSON.stringify([background_url, urls]);
        if (last_urls_hash === urls_hash) {
          checking = false;
          return;
        }
        last_urls_hash = urls_hash;

        clearInterval(check_interval);
        checking = false;
        return resolve({ task, is_hard, cells, background_url, urls });
      }, i);
    });
  }

  function submit() {
    document.querySelector('#recaptcha-verify-button')?.click();
  }

  function got_solve_incorrect() {
    const errors = [
      '.rc-imageselect-incorrect-response', // try again
    ];
    for (const e of errors) {
      if (document.querySelector(e)?.style['display'] === '') {
        return true;
      }
    }
    return false;
  }

  function got_solve_error() {
    // <div aria-live="polite">
    //     <div class="rc-imageselect-error-select-more" style="" tabindex="0">Please select all matching images.</div>
    //     <div class="rc-imageselect-error-dynamic-more" style="display:none">Please also check the new images.</div>
    //     <div class="rc-imageselect-error-select-something" style="display:none">Please select around the object, or reload if there are none.</div>
    // </div>

    const errors = [
      '.rc-imageselect-error-select-more', // select all matching images
      '.rc-imageselect-error-dynamic-more', // please also check the new images
      '.rc-imageselect-error-select-something', // select around the object or reload
    ];
    for (const e of errors) {
      const $e = document.querySelector(e);
      if ($e?.style['display'] === '' || $e?.tabIndex === 0) {
        return true;
      }
    }
    return false;
  }

  function is_cell_selected($cell) {
    try {
      return $cell.classList.contains('rc-imageselect-tileselected');
    } catch {}
    return false;
  }

  async function on_widget_frame() {
    // Check if parent frame marked this frame as visible on screen
    // const is_visible = await BG.exec('Cache.get', {name: 'recaptcha_widget_visible', tab_specific: true});
    // if (is_visible !== true) {
    //     return;
    // }

    // Wait if already solved
    if (is_solved()) {
      if (!was_solved) {
        was_solved = true;
      }
      return;
    }
    was_solved = false;
    await Time.sleep(500);
    open_image_frame();
  }

  async function on_image_frame() {
    // Check if parent frame marked this frame as visible on screen
    // const is_visible = await BG.exec('Cache.get', {name: 'recaptcha_image_visible', tab_specific: true});
    // if (is_visible !== true) {
    //     return;
    // }

    if (is_rate_limited()) {
      console.log('rate limited');
      return;
    }

    // Wait if verify button is disabled
    if (is_solved()) {
      return;
    }

    // Incorrect solution
    if (!was_incorrect && got_solve_incorrect()) {
      solved_urls = [];
      was_incorrect = true;
    } else {
      was_incorrect = false;
    }

    // Select more images error
    if (got_solve_error()) {
      solved_urls = [];
      console.log('ERROR DET');
      // await BG.exec('reset_recaptcha');
      return;
    }

    // Wait for images to load
    const is_ready = await on_images_ready();
    if (!is_ready) {
      // await BG.exec('reset_recaptcha');
      return;
    }

    // Wait for task to be available
    const { task, is_hard, cells, background_url, urls } =
      await on_task_ready();

    const image_urls = [];
    const n = cells.length == 9 ? 3 : 4;
    let clickable_cells = []; // Variable number of clickable cells if secondary images appear
    if (background_url === null) {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const cell = cells[i];
        if (url && !solved_urls.includes(url)) {
          image_urls.push(url);
          clickable_cells.push(cell);
        }
      }
    } else {
      image_urls.push(background_url);
      clickable_cells = cells;
    }

    const label_cv = {
      bicycle: 'bicycle',
      bicycles: 'bicycle',
      bridge: 'bridge',
      bridges: 'bridge',
      bus: 'bus',
      buses: 'bus',
      car: 'car',
      cars: 'car',
      chimney: 'chimney',
      chimneys: 'chimney',
      crosswalk: 'crosswalk',
      crosswalks: 'crosswalk',
      'fire hydrant': 'fire hydrant',
      motorcycle: 'motorcycle',
      motorcycles: 'motorcycle',
      mountain: 'mountain',
      mountains: 'mountain',
      'palm trees': 'palm tree',
      stair: 'stair',
      stairs: 'stair',
      'traffic light': 'traffic light',
      'traffic lights': 'traffic light',
    };
    const featSession = await ort.InferenceSession.create(
      `chrome-extension://${extension_id}/models/mobilenetv3-large.ort`
    );

    const data = [];
    const label = task
      .replace('Select all squares with', '')
      .replace('Select all images with', '')
      .trim()
      .replace(/^(a|an)\s+/i, '')
      .replace(/\s+/g, '_')
      .toLowerCase();

    const subImages = [];
    if (background_url === null) {
      for (let i = 0; i < image_urls.length; i++) {
        const url = image_urls[i];
        const subImage = await Jimp.default.read(url);
        subImage.rgba(false);
        subImages.push(subImage);
      }
    } else {
      const image = await Jimp.default.read(background_url);
      const cropSize = image.bitmap.width / n;
      image.rgba(false);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          subImages.push(image.clone().crop(j * cropSize, i * cropSize, cropSize, cropSize));
        }
      }
    }

    console.log(subImages);
    const classifierSession = await ort.InferenceSession.create(
      `chrome-extension://${extension_id}/models/${label_cv[label]}.ort`
    );

    for (let i = 0; i < subImages.length; i++) {
      const subImage = subImages[i];
      subImage.resize(224, 224, Jimp.RESIZE_BILINEAR);
      subImage.rgba(false);
      const input = imageDataToTensor(subImage, [1, 3, 224, 224]);
      const featOutputs = await featSession.run({ input: input });
      const feats = featOutputs[featSession.outputNames[0]];
      const classifierOutputs = await classifierSession.run({
        input: feats,
      });
      const output = classifierOutputs[classifierSession.outputNames[0]].data;
      const argmaxValue = output.indexOf(Math.max(...output));
      data.push(argmaxValue == 1);
    }

    console.log(data);
    // Submit solution
    let clicks = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === false) {
        continue;
      }
      clicks++;

      // Click if not already selected
      if (!is_cell_selected(clickable_cells[i])) {
        clickable_cells[i]?.click();
        await Time.sleep(1000);
      }
    }

    for (const url of urls) {
      solved_urls.push(url);
      if (solved_urls.length > 9) {
        solved_urls.shift();
      }
    }
    await Time.sleep(3000);
    if (
      (n === 3 && is_hard && clicks === 0 && (await on_images_ready())) ||
      (n === 3 && !is_hard) ||
      n === 4
    ) {
      await Time.sleep(200);
      submit();
    }
  }

  async function check_image_frame_visibility() {
    const $image_frames = [
      ...document.querySelectorAll('iframe[src*="/recaptcha/api2/bframe"]'),
      ...document.querySelectorAll(
        'iframe[src*="/recaptcha/enterprise/bframe"]'
      ),
    ];
    if ($image_frames.length > 0) {
      for (const $frame of $image_frames) {
        if (window.getComputedStyle($frame).visibility === 'visible') {
          return await BG.exec('Cache.set', {
            name: 'recaptcha_image_visible',
            value: true,
            tab_specific: true,
          });
        }
      }
      await BG.exec('Cache.set', {
        name: 'recaptcha_image_visible',
        value: false,
        tab_specific: true,
      });
    }
  }

  async function check_widget_frame_visibility() {
    const $widget_frames = [
      ...document.querySelectorAll('iframe[src*="/recaptcha/api2/anchor"]'),
      ...document.querySelectorAll(
        'iframe[src*="/recaptcha/enterprise/anchor"]'
      ),
    ];
    if ($widget_frames.length > 0) {
      for (const $frame of $widget_frames) {
        if (window.getComputedStyle($frame).visibility === 'visible') {
          return await BG.exec('Cache.set', {
            name: 'recaptcha_widget_visible',
            value: true,
            tab_specific: true,
          });
        }
      }
      await BG.exec('Cache.set', {
        name: 'recaptcha_widget_visible',
        value: false,
        tab_specific: true,
      });
    }
    return false;
  }

  let was_solved = false;
  let was_incorrect = false;
  let solved_urls = [];

  while (true) {
    await Time.sleep(1000);

    // await check_image_frame_visibility();
    // await check_widget_frame_visibility();

    if (is_widget_frame()) {
      await on_widget_frame();
    } else if (is_image_frame()) {
      await on_image_frame();
    }
  }
})();
