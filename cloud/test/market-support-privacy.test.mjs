import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marketPrivacyFindings, runClusterEvolutionCore } from '../../src/shared/evolution/phase8.js';

test('market section support ignores proposer-supplied instance IDs and requires three reviewer-confirmed users', async () => {
  const evidence=clusterEvidence(['verification evidence','verification evidence','unrelated task','unrelated task','unrelated task','unrelated task','unrelated task']);
  const result=await runClusterEvolutionCore({cohort:cohort(),evidence,modelExecutor:marketModel({
    proposal:{summary:'Shared verification',sections:[{section_id:'verification.workflow',title:'Verification',
      content:'Verify every deliverable.',capability_tags:['verification'],supporting_instance_ids:['fake-a','fake-b','fake-c']}],
    eval_cases:[{input:'deliver',expected:'verify'}],risks:['cost']},
  })});
  assert.equal(result.status,'rejected');
  assert.equal(result.reason,'market_gate_rejected');
  assert.equal(result.gate.sectionSupport[0].supportCount,0);
  assert.ok(result.gate.reasons.some((item)=>item.includes('three independently verified')));
});

test('market section support reviewer cannot forge unknown Evidence handles', async () => {
  const result=await runClusterEvolutionCore({cohort:cohort(),evidence:clusterEvidence(),modelExecutor:marketModel({
    supportHandles:()=>['evidence_forged_1','evidence_forged_2','evidence_forged_3'],
  })});
  assert.equal(result.status,'rejected');
  assert.equal(result.gate.sectionSupport[0].supportCount,0);
  assert.equal(result.gate.sectionSupport[0].reviewerStatus,'rejected');
});

test('market privacy detector rejects identity, contact, secret, path, URL, project, and single-user facts', () => {
  const context={knownIdentityTerms:['Alice Example'],knownIdentifiers:['instance_secret_123456'],sensitiveTerms:['Project Moonlight'],
    evidence:[{ownerUserId:'one',content:'the unreleased launch phrase belongs to one customer only'},
      {ownerUserId:'two',content:'generic verification guidance'}]};
  const attacks=[
    'Alice Example owns this rule.',
    'Contact owner@example.com.',
    'instance_secret_123456',
    'api_key: abcdefghijklmnopqrstuvwxyz',
    '/home/alice/private/plan.txt',
    'https://private.example.test/roadmap',
    'Project Moonlight launches tomorrow.',
    'the unreleased launch phrase belongs to one customer only',
  ];
  for(const attack of attacks)assert.ok(marketPrivacyFindings(attack,context).length>0,attack);
});

test('market candidate is scanned by an independent reviewer again before Shadow and exposes only support counts publicly', async () => {
  const result=await runClusterEvolutionCore({cohort:cohort(),evidence:clusterEvidence(),modelExecutor:marketModel({rejectFinalPrivacy:true})});
  assert.equal(result.status,'rejected');
  assert.equal(result.reason,'market_privacy_rejected');
  assert.equal(result.familyResults[0].finalPrivacyReview.reviewerStatus,'rejected');
  assert.equal(JSON.stringify(result.proposal).includes('supporting_instance_ids'),false);
  assert.equal(JSON.stringify(result.gate).includes('evidenceId'),false);
  assert.ok(result.gate.sectionSupport[0].supportCount>=3);
});

function cohort(){return {type:'family',familyId:'family',departmentId:'department',members:Array.from({length:7},(_,index)=>({
  ownerUserId:`user_${index}`,agentInstanceId:`instance_${index}`,agentFamilyId:'family',
}))};}

function clusterEvidence(contents=Array.from({length:7},()=> 'verification evidence for reliable delivery')){
  return contents.map((content,index)=>({evidenceId:`evidence_${index}`,ownerUserId:`user_${index}`,agentInstanceId:`instance_${index}`,
    sourceKind:'task_result',content,effectiveWeight:1}));
}

function marketModel({proposal=null,supportHandles=null,rejectFinalPrivacy=false}={}){
  const resolvedProposal=proposal||{summary:'Shared verification',sections:[{section_id:'verification.workflow',title:'Verification',
    content:'Verify every deliverable.',capability_tags:['verification'],conflict_keys:['verify']}],
  eval_cases:[{input:'deliver',expected:'verify'}],risks:['cost']};
  return async({kind,prompt})=>{
    if(kind==='cluster_proposal')return JSON.stringify(resolvedProposal);
    if(kind==='cluster_support_review'){
      const parsed=JSON.parse(prompt);const handles=typeof supportHandles==='function'?supportHandles(parsed):parsed.evidence.map((item)=>item.evidence_handle);
      return JSON.stringify({decision:'supported',supported_evidence_handles:handles,rationale:'independently grounded'});
    }
    if(kind==='cluster_privacy_review'){
      const parsed=JSON.parse(prompt);const reject=rejectFinalPrivacy&&parsed.reviewStage==='final_pre_shadow';
      return JSON.stringify({decision:reject?'reject':'pass',flags:reject?['single_user_fact']:[],rationale:reject?'final scan rejected':'safe'});
    }
    if(kind==='cluster_governance_review')return JSON.stringify({decision:'full',approved_section_ids:['verification.workflow']});
    if(kind==='cluster_replay_judge')return JSON.stringify({winner:'candidate',baseline_score:.5,candidate_score:.8,
      privacy_violation:false,role_violation:false});
    return 'verified';
  };
}
