import {useEffect,useRef,useState} from 'react';
import {BrowserCodeReader,BrowserMultiFormatReader} from '@zxing/browser';
import {Camera,Check,LoaderCircle,X} from 'lucide-react';

type Props={
  rtl:boolean;
  defaultDeviceId?:string;
  onClose:()=>void;
  onDetected:(value:string)=>void;
};

export default function CameraScanner({rtl,defaultDeviceId='',onClose,onDetected}:Props){
  const videoRef=useRef<HTMLVideoElement|null>(null);
  const controlsRef=useRef<{stop:()=>void}|null>(null);
  const detectedRef=useRef(false);
  const onDetectedRef=useRef(onDetected);
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId,setSelectedDeviceId]=useState(defaultDeviceId);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');

  useEffect(()=>{onDetectedRef.current=onDetected;},[onDetected]);

  useEffect(()=>{
    let cancelled=false;
    const discover=async()=>{
      setLoading(true);
      setError('');
      try{
        if(!navigator.mediaDevices?.getUserMedia)throw new Error(rtl?'الوصول للكاميرا غير متاح.':'Camera access is unavailable.');
        const permissionStream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
        permissionStream.getTracks().forEach(track=>track.stop());
        const cameras=await BrowserCodeReader.listVideoInputDevices();
        if(cancelled)return;
        if(!cameras.length)throw new Error(rtl?'لم يتم العثور على كاميرا. وصّل كاميرا USB أو فعّل الهاتف ككاميرا ويب في ويندوز.':'No camera was found. Connect a USB webcam or enable your phone as a Windows webcam.');
        setDevices(cameras);
        setSelectedDeviceId(current=>{
          if(current&&cameras.some(camera=>camera.deviceId===current))return current;
          if(defaultDeviceId&&cameras.some(camera=>camera.deviceId===defaultDeviceId))return defaultDeviceId;
          const rear=cameras.find(camera=>/back|rear|environment/i.test(camera.label));
          return (rear||cameras[0]).deviceId;
        });
      }catch(value:any){
        if(cancelled)return;
        const message=String(value?.message||value);
        const permissionDenied=value?.name==='NotAllowedError'||value?.name==='PermissionDeniedError'||/permission|denied/i.test(message);
        setError(permissionDenied
          ?(rtl?'لم يتم السماح باستخدام الكاميرا. اسمح لكاشو بالوصول إلى الكاميرا من إعدادات ويندوز.':'Camera permission was denied. Allow Kasho to access the camera in Windows settings.')
          :message);
      }finally{if(!cancelled)setLoading(false);}
    };
    discover();
    return ()=>{cancelled=true;controlsRef.current?.stop();controlsRef.current=null;};
  },[defaultDeviceId,rtl]);

  useEffect(()=>{
    if(!selectedDeviceId||!videoRef.current)return;
    let stopped=false;
    let activeControls:{stop:()=>void}|null=null;
    detectedRef.current=false;
    setError('');
    const reader=new BrowserMultiFormatReader();
    reader.decodeFromVideoDevice(selectedDeviceId,videoRef.current,(result)=>{
      if(!result||stopped||detectedRef.current)return;
      const value=result.getText().trim();
      if(!value)return;
      detectedRef.current=true;
      activeControls?.stop();
      controlsRef.current?.stop();
      onDetectedRef.current(value);
    }).then(controls=>{
      activeControls=controls;
      controlsRef.current=controls;
      if(stopped)controls.stop();
    }).catch((value:any)=>{
      if(!stopped){
        const message=String(value?.message||value);
        setError(value?.name==='NotAllowedError'
          ?(rtl?'رفض ويندوز الوصول إلى الكاميرا.':'Windows denied access to the camera.')
          :message);
      }
    });
    return ()=>{
      stopped=true;
      activeControls?.stop();
      if(controlsRef.current===activeControls)controlsRef.current=null;
    };
  },[selectedDeviceId,rtl]);

  const close=()=>{
    controlsRef.current?.stop();
    controlsRef.current=null;
    onClose();
  };

  return <div className="overlay camera-overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}>
    <section className="modal camera-modal" dir={rtl?'rtl':'ltr'} role="dialog" aria-modal="true" aria-labelledby="camera-scan-title">
      <header><h2 id="camera-scan-title">{rtl?'مسح بالكاميرا':'Scan with camera'}</h2><button type="button" aria-label={rtl?'إغلاق':'Close'} onClick={close}><X size={18}/></button></header>
      <div className="camera-device-row">
        <label>{rtl?'مصدر الكاميرا':'Camera source'}</label>
        <select value={selectedDeviceId} disabled={loading||devices.length===0} onChange={e=>setSelectedDeviceId(e.target.value)}>
          {devices.map((device,index)=><option key={device.deviceId} value={device.deviceId}>{device.label||((rtl?'كاميرا ':'Camera ')+(index+1))}</option>)}
        </select>
      </div>
      <div className="camera-preview">
        <video ref={videoRef} autoPlay muted playsInline/>
        <span className="camera-scan-frame" aria-hidden="true"/>
        {loading&&<div className="camera-loading"><LoaderCircle className="spin" size={22}/><span>{rtl?'جارٍ تجهيز الكاميرا...':'Starting camera...'}</span></div>}
        {!loading&&error&&<div className="camera-error"><Camera size={28}/><p>{error}</p></div>}
      </div>
      <div className="camera-footer">
        <span><Check size={16}/>{rtl?'يدعم QR والباركود الشائع':'Supports QR and common 1D/2D barcodes'}</span>
        <small>{rtl?'وجّه الكود داخل الإطار وثبّت الهاتف لحظة القراءة.':'Center the code in the frame and hold the camera steady.'}</small>
      </div>
      {error&&<div className="camera-help">{rtl?'يمكنك استخدام ماسح USB العادي كلوحة مفاتيح في حقل الباركود بدون فتح الكاميرا.':'Your regular USB HID scanner can still type directly into the barcode field without opening the camera.'}</div>}
      <div className="modal-actions"><button type="button" onClick={close}>{rtl?'إغلاق':'Close'}</button></div>
    </section>
  </div>;
}
