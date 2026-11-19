import React, { useState, DragEvent, ChangeEvent } from 'react';
import { Upload, FileUp } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  disabled: boolean;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, disabled }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.name.toLowerCase().endsWith('.epub')) {
        setError(null);
        onFileSelect(file);
      } else {
        setError("请上传有效的 .epub 电子书文件");
      }
    }
    event.target.value = '';
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDragging(true);
    }
  };

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Prevent flickering when dragging over child elements
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      // Basic validation for EPUB extension
      if (file.name.toLowerCase().endsWith('.epub')) {
        setError(null);
        onFileSelect(file);
      } else {
        setError("请上传有效的 .epub 电子书文件");
      }
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border border-dashed rounded-none transition-all duration-300 group
        ${disabled 
          ? 'opacity-50 cursor-not-allowed border-neutral-300 bg-neutral-50' 
          : isDragging 
            ? 'border-black bg-neutral-100 ring-1 ring-black' 
            : 'border-black hover:border-black hover:bg-neutral-50 bg-white'
        }`}
    >
      <input
        type="file"
        accept=".epub"
        onChange={handleFileChange}
        disabled={disabled}
        className="hidden"
        id="epub-upload"
      />
      <label 
        htmlFor="epub-upload" 
        className={`flex flex-col items-center justify-center w-full p-8 gap-4 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <div className={`p-4 rounded-none border border-black shrink-0 transition-all duration-300 ${isDragging ? 'bg-black scale-110' : 'bg-white group-hover:bg-black group-hover:scale-105'}`}>
          {isDragging ? (
            <FileUp className={`w-8 h-8 text-white`} />
          ) : (
            <Upload className="w-8 h-8 text-black group-hover:text-white transition-colors" />
          )}
        </div>
        
        <div className="flex flex-col items-center text-center">
          <h3 className={`font-mono uppercase tracking-widest text-lg font-medium transition-colors ${isDragging ? 'text-black' : 'text-black'}`}>
            {isDragging ? "释放立即上传" : "上传 EPUB 电子书"}
          </h3>
          <p className={`text-sm mt-1.5 font-mono transition-colors ${isDragging ? 'text-black' : 'text-neutral-500'}`}>
            {isDragging ? "松开鼠标开始解析" : "点击选择或拖拽 EPUB 文件到此处"}
          </p>
          {error && (
            <p className="text-sm mt-3 text-white font-mono bg-black px-3 py-1 rounded-none border border-black">
              {error}
            </p>
          )}
        </div>
      </label>
    </div>
  );
};

export default FileUpload;