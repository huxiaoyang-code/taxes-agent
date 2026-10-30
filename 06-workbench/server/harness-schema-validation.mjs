// 完整 draft-07 JSON Schema 校验；不补默认值、不转换类型、不删除输入值。
import Ajv from 'ajv';
const ajv=new Ajv({allErrors:true,strictSchema:true,strictTypes:false,strictTuples:false,strictRequired:false,allowUnionTypes:true,ownProperties:true,useDefaults:false,coerceTypes:false,removeAdditional:false,verbose:false});
ajv.addFormat('calendar-date',{type:'string',validate:value=>{if(!/^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===value;}});
ajv.addFormat('utc-timestamp',{type:'string',validate:value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value});
const validators=new WeakMap();
export function compileHarnessSchema(schema){let validate=validators.get(schema);if(!validate){validate=ajv.compile(schema);validators.set(schema,validate);}return validate;}
export function validateSchemaValue(schema,value,{field='arguments'}={}){
 const validate=compileHarnessSchema(schema);if(validate(value))return [];
 return validate.errors.map(error=>{const suffix=error.keyword==='required'?'/'+escapePointer(error.params.missingProperty):error.keyword==='additionalProperties'?'/'+escapePointer(error.params.additionalProperty):'';const pointer=error.instancePath+suffix;return {field:field+pointer,inputPointer:pointer,keyword:error.keyword,expected:error.keyword==='required'?'required field':error.keyword==='additionalProperties'?'only declared properties':error.message,hint:error.keyword==='required'?'Provide this field from actual facts or keep the business task blocked.':error.keyword==='additionalProperties'?'Remove or correct this undeclared input field; inspect the selected tool/capability schema.':'Use the declared type, format, enum and bounds. Values were not modified.'};});
}
const escapePointer=value=>String(value).replaceAll('~','~0').replaceAll('/','~1');
