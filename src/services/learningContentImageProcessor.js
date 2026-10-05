const sharp = require('sharp');
const {fail} = require('./learningContentValidation');
async function sanitizeImage(buffer) {
  try {
    const image=sharp(buffer,{limitInputPixels:16000000,animated:false});
    const meta=await image.metadata();
    if (!['jpeg','png','webp'].includes(meta.format) || (meta.pages || 1)>1) fail('Use a static JPEG, PNG or WebP image');
    return await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer({resolveWithObject:true});
  } catch { fail('This file is not a supported image, or exceeds 16 megapixels'); }
}
module.exports={sanitizeImage};
