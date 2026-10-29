const bad=()=>{throw Error('harness2_anthropic_protocol_unsupported');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function text(blocks){
  if(typeof blocks==='string')return blocks;
  if(!Array.isArray(blocks))bad();
  return blocks.map(block=>{if(!object(block)||block.type!=='text'||typeof block.text!=='string')bad();return block.text;}).join('\n');
}
export function decodeAnthropicRequest(body){
  if(!object(body)||body.model!=='deepseek-flash'||!Array.isArray(body.messages)||!body.messages.length||!Number.isSafeInteger(body.max_tokens)||body.max_tokens<1)bad();
  if(Object.keys(body).some(key=>!['model','messages','system','tools','tool_choice','max_tokens','stream','temperature','top_p','top_k','stop_sequences','thinking','output_config','metadata','betas','context_management','service_tier'].includes(key)))bad();
  if(body.stream!==undefined&&typeof body.stream!=='boolean')bad();
  if(body.thinking!==undefined&&(!object(body.thinking)||!['enabled','disabled','adaptive'].includes(body.thinking.type)))bad();
  if(body.top_k!==undefined||(body.stop_sequences?.length??0)>0)bad();
  const result={model:body.model,messages:[],max_tokens:body.max_tokens,stream:body.stream===true,reasoning_effort:'low'};
  if(body.system!==undefined)result.messages.push({role:'system',content:text(body.system)});
  for(const message of body.messages){
    if(!object(message)||!['user','assistant'].includes(message.role))bad();
    const blocks=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;if(!Array.isArray(blocks))bad();
    const prose=[],thinking=[],calls=[];
    for(const block of blocks){
      if(!object(block))bad();
      if(block.type==='text'&&typeof block.text==='string')prose.push(block.text);
      else if(block.type==='thinking'&&message.role==='assistant'&&typeof block.thinking==='string')thinking.push(block.thinking);
      else if(block.type==='tool_use'&&message.role==='assistant'&&typeof block.id==='string'&&typeof block.name==='string'&&object(block.input))calls.push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}});
      else if(block.type==='tool_result'&&message.role==='user'&&typeof block.tool_use_id==='string')result.messages.push({role:'tool',tool_call_id:block.tool_use_id,content:block.is_error?JSON.stringify({is_error:true,content:text(block.content??'')}):text(block.content??'')});
      else bad();
    }
    if(prose.length||calls.length||thinking.length)result.messages.push({role:message.role,content:prose.length?prose.join('\n'):null,...calls.length?{tool_calls:calls}:{},...thinking.length?{reasoning_content:thinking.join('\n')}:{}});
  }
  if(body.tools!==undefined){if(!Array.isArray(body.tools))bad();result.tools=body.tools.map(tool=>{if(!object(tool)||typeof tool.name!=='string'||!object(tool.input_schema)||(tool.type&&tool.type!=='custom')||(tool.description!==undefined&&typeof tool.description!=='string'))bad();return {type:'function',function:{name:tool.name,...tool.description!==undefined?{description:tool.description}:{},parameters:tool.input_schema}};});}
  if(body.tool_choice!==undefined){const choice=body.tool_choice;if(!object(choice))bad();if(choice.type==='auto')result.tool_choice='auto';else if(choice.type==='any')result.tool_choice='required';else if(choice.type==='none')result.tool_choice='none';else if(choice.type==='tool'&&typeof choice.name==='string')result.tool_choice={type:'function',function:{name:choice.name}};else bad();}
  for(const key of ['temperature','top_p'])if(body[key]!==undefined){if(typeof body[key]!=='number'||!Number.isFinite(body[key]))bad();result[key]=body[key];}
  if(body.output_config?.effort!==undefined&&body.output_config.effort!=='low')bad();
  return result;
}
export function encodeAnthropicResponse(chat,{stream=false}={}){
  const choice=chat?.choices?.[0],message=choice?.message,usage=chat?.usage;
  if(chat?.model!=='deepseek-flash'||!object(message)||!Number.isSafeInteger(usage?.prompt_tokens)||usage.prompt_tokens<0||!Number.isSafeInteger(usage?.completion_tokens)||usage.completion_tokens<0)bad();
  const content=[];
  if(message.reasoning_content)content.push({type:'thinking',thinking:message.reasoning_content,signature:'harness2-local-protocol-adapter'});
  if(typeof message.content==='string'&&message.content)content.push({type:'text',text:message.content});
  for(const call of message.tool_calls??[]){let input;try{input=JSON.parse(call.function.arguments);}catch{bad();}if(call.type!=='function'||typeof call.id!=='string'||typeof call.function.name!=='string'||!object(input))bad();content.push({type:'tool_use',id:call.id,name:call.function.name,input});}
  if(!content.length)content.push({type:'text',text:''});
  const stop=content.some(block=>block.type==='tool_use')?'tool_use':choice.finish_reason==='length'?'max_tokens':'end_turn';
  const value={id:chat.id??'harness2-message',type:'message',role:'assistant',model:'deepseek-flash',content,stop_reason:stop,stop_sequence:null,usage:{input_tokens:usage.prompt_tokens,output_tokens:usage.completion_tokens}};
  if(!stream)return {contentType:'application/json',body:JSON.stringify(value)};
  const events=[],emit=(event,data)=>events.push('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');
  emit('message_start',{type:'message_start',message:{...value,content:[],stop_reason:null,usage:{input_tokens:usage.prompt_tokens,output_tokens:0}}});
  content.forEach((block,index)=>{
    emit('content_block_start',{type:'content_block_start',index,content_block:block.type==='tool_use'?{...block,input:{}}:block.type==='thinking'?{type:'thinking',thinking:'',signature:''}:{type:'text',text:''}});
    if(block.type==='tool_use')emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
    else if(block.type==='thinking'){emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'thinking_delta',thinking:block.thinking}});emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'signature_delta',signature:block.signature}});}
    else emit('content_block_delta',{type:'content_block_delta',index,delta:{type:'text_delta',text:block.text}});
    emit('content_block_stop',{type:'content_block_stop',index});
  });
  emit('message_delta',{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:usage.completion_tokens}});emit('message_stop',{type:'message_stop'});
  return {contentType:'text/event-stream',body:events.join('')};
}
