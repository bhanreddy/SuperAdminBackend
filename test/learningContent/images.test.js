const test=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {sanitizeImage}=require('../../src/services/learningContentImageProcessor');
test('rejects disguised HTML, SVG and broken image bytes',async()=>{
  for(const value of ['<html>not an image</html>','<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>','broken jpeg']){
    await assert.rejects(()=>sanitizeImage(Buffer.from(value)),e=>e.statusCode===422);
  }
});
test('converts and bounds images without upscaling and strips metadata',async()=>{
  for(const [width,height] of [[2000,1000],[100,50]]){
    const source=await sharp({create:{width,height,channels:4,background:{r:100,g:120,b:140,alpha:0.5}}}).png().withMetadata().toBuffer();
    const output=await sanitizeImage(source);const meta=await sharp(output.data).metadata();
    assert.equal(meta.format,'webp');assert.equal(meta.width,Math.min(width,1600));assert.ok(meta.height<=1600);assert.equal(meta.exif,undefined);
  }
});
test('rejects images beyond the decoded pixel budget',async()=>{
  const source=await sharp({create:{width:4100,height:4100,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(()=>sanitizeImage(source),e=>e.statusCode===422);
});
